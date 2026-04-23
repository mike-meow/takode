// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { SessionState, SdkSessionInfo } from "../types.js";

// ─── Mock setup ──────────────────────────────────────────────────────────────

const mockConnectSession = vi.fn();
const mockConnectAllSessions = vi.fn();
const mockDisconnectSession = vi.fn();

vi.mock("../ws.js", () => ({
  connectSession: (...args: unknown[]) => mockConnectSession(...args),
  connectAllSessions: (...args: unknown[]) => mockConnectAllSessions(...args),
  disconnectSession: (...args: unknown[]) => mockDisconnectSession(...args),
}));

vi.mock("../utils/pending-creation.js", () => ({
  cancelPendingCreation: vi.fn(),
}));

const mockApi = {
  listSessions: vi.fn().mockResolvedValue([]),
  searchSessions: vi.fn().mockResolvedValue({ query: "", tookMs: 0, totalMatches: 0, results: [] }),
  deleteSession: vi.fn().mockResolvedValue({}),
  archiveSession: vi.fn().mockResolvedValue({}),
  archiveGroup: vi.fn().mockResolvedValue({ ok: true, archived: 1, failed: 0 }),
  unarchiveSession: vi.fn().mockResolvedValue({}),
  herdWorkerToLeader: vi
    .fn()
    .mockResolvedValue({ herded: ["worker-1"], notFound: [], conflicts: [], reassigned: [], leaders: [] }),
  getSettings: vi.fn().mockResolvedValue({ serverName: "" }),
  updateSettings: vi.fn().mockResolvedValue({}),
  getTreeGroups: vi
    .fn()
    .mockResolvedValue({ groups: [{ id: "default", name: "Default" }], assignments: {}, nodeOrder: {} }),
};

vi.mock("../api.js", () => ({
  api: {
    listSessions: (...args: unknown[]) => mockApi.listSessions(...args),
    searchSessions: (...args: unknown[]) => mockApi.searchSessions(...args),
    deleteSession: (...args: unknown[]) => mockApi.deleteSession(...args),
    archiveSession: (...args: unknown[]) => mockApi.archiveSession(...args),
    archiveGroup: (...args: unknown[]) => mockApi.archiveGroup(...args),
    unarchiveSession: (...args: unknown[]) => mockApi.unarchiveSession(...args),
    herdWorkerToLeader: (...args: unknown[]) => mockApi.herdWorkerToLeader(...args),
    getSettings: (...args: unknown[]) => mockApi.getSettings(...args),
    updateSettings: (...args: unknown[]) => mockApi.updateSettings(...args),
    getTreeGroups: (...args: unknown[]) => mockApi.getTreeGroups(...args),
  },
}));

const mockWriteClipboardText = vi.fn().mockResolvedValue(undefined);
const mockAlert = vi.fn();
vi.mock("../utils/copy-utils.js", () => ({
  writeClipboardText: (...args: unknown[]) => mockWriteClipboardText(...args),
}));

// ─── Store mock helpers ──────────────────────────────────────────────────────

// We need to mock the store. The Sidebar uses `useStore((s) => s.xxx)` selector pattern.
// We'll provide a real-ish mock that supports selector calls.

interface MockStoreState {
  sessions: Map<string, SessionState>;
  sdkSessions: SdkSessionInfo[];
  currentSessionId: string | null;
  cliConnected: Map<string, boolean>;
  cliDisconnectReason: Map<string, "idle_limit" | null>;
  sessionStatus: Map<string, "idle" | "running" | "compacting" | null>;
  sessionNames: Map<string, string>;
  sessionPreviews: Map<string, string>;
  sessionPreviewUpdatedAt: Map<string, number>;
  sessionTaskPreview: Map<string, string>;
  sessionTaskHistory: Map<string, Array<{ title: string; action: string; timestamp: number }>>;
  sessionKeywords: Map<string, string[]>;
  recentlyRenamed: Set<string>;
  questNamedSessions: Set<string>;
  pendingPermissions: Map<string, Map<string, unknown>>;
  sessionAttention: Map<string, "action" | "error" | "review" | null>;
  diffFileStats: Map<string, Map<string, { additions: number; deletions: number }>>;
  shortcutSettings: {
    enabled: boolean;
    preset: "standard" | "vscode-light" | "vim-light";
    overrides: Record<string, string | null>;
  };
  sessionInfoOpenSessionId: string | null;
  reorderMode: boolean;
  setReorderMode: ReturnType<typeof vi.fn>;
  pendingSessions: Map<string, unknown>;
  serverName: string;
  treeGroups: Array<{ id: string; name: string }>;
  treeAssignments: Map<string, string>;
  treeNodeOrder: Map<string, string[]>;
  collapsedTreeGroups: Set<string>;
  collapsedTreeNodes: Set<string>;
  expandedHerdNodes: Set<string>;
  toggleTreeGroupCollapse: ReturnType<typeof vi.fn>;
  toggleTreeNodeCollapse: ReturnType<typeof vi.fn>;
  toggleHerdNodeExpand: ReturnType<typeof vi.fn>;
  setServerName: ReturnType<typeof vi.fn>;
  setCurrentSession: ReturnType<typeof vi.fn>;
  removeSession: ReturnType<typeof vi.fn>;
  newSession: ReturnType<typeof vi.fn>;
  setSidebarOpen: ReturnType<typeof vi.fn>;
  setSessionName: ReturnType<typeof vi.fn>;
  setSessionPreview: ReturnType<typeof vi.fn>;
  setSessionTaskHistory: ReturnType<typeof vi.fn>;
  setSessionKeywords: ReturnType<typeof vi.fn>;
  markRecentlyRenamed: ReturnType<typeof vi.fn>;
  clearRecentlyRenamed: ReturnType<typeof vi.fn>;
  setSdkSessions: ReturnType<typeof vi.fn>;
  closeTerminal: ReturnType<typeof vi.fn>;
  openNewSessionModal: ReturnType<typeof vi.fn>;
  closeNewSessionModal: ReturnType<typeof vi.fn>;
  markSessionViewed: ReturnType<typeof vi.fn>;
  markAllSessionsViewed: ReturnType<typeof vi.fn>;
  markSessionUnread: ReturnType<typeof vi.fn>;
  clearSessionAttention: ReturnType<typeof vi.fn>;
  setTreeGroups: ReturnType<typeof vi.fn>;
}

function makeSession(id: string, overrides: Partial<SessionState> = {}): SessionState {
  return {
    session_id: id,
    model: "claude-sonnet-4-5-20250929",
    cwd: "/home/user/projects/myapp",
    tools: [],
    permissionMode: "default",
    claude_code_version: "1.0",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    total_cost_usd: 0,
    num_turns: 0,
    context_used_percent: 0,
    is_compacting: false,
    git_branch: "",
    is_worktree: false,
    is_containerized: false,
    repo_root: "",
    git_ahead: 0,
    git_behind: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
    ...overrides,
  };
}

function makeSdkSession(id: string, overrides: Partial<SdkSessionInfo> = {}): SdkSessionInfo {
  return {
    sessionId: id,
    state: "connected",
    cwd: "/home/user/projects/myapp",
    createdAt: Date.now(),
    archived: false,
    ...overrides,
  };
}

let mockState: MockStoreState;

function createMockState(overrides: Partial<MockStoreState> = {}): MockStoreState {
  return {
    sessions: new Map(),
    sdkSessions: [],
    currentSessionId: null,
    cliConnected: new Map(),
    cliDisconnectReason: new Map(),
    sessionStatus: new Map(),
    sessionNames: new Map(),
    sessionPreviews: new Map(),
    sessionPreviewUpdatedAt: new Map(),
    sessionTaskPreview: new Map(),
    sessionTaskHistory: new Map(),
    sessionKeywords: new Map(),
    recentlyRenamed: new Set(),
    questNamedSessions: new Set(),
    pendingPermissions: new Map(),
    sessionAttention: new Map(),
    diffFileStats: new Map(),
    shortcutSettings: { enabled: false, preset: "standard", overrides: {} },
    sessionInfoOpenSessionId: null,
    reorderMode: false,
    setReorderMode: vi.fn(),
    pendingSessions: new Map(),
    serverName: "",
    treeGroups: [],
    treeAssignments: new Map(),
    treeNodeOrder: new Map(),
    collapsedTreeGroups: new Set(),
    collapsedTreeNodes: new Set(),
    expandedHerdNodes: new Set(),
    toggleTreeGroupCollapse: vi.fn(),
    toggleTreeNodeCollapse: vi.fn(),
    toggleHerdNodeExpand: vi.fn(),
    setServerName: vi.fn(),
    setCurrentSession: vi.fn(),
    removeSession: vi.fn(),
    newSession: vi.fn(),
    setSidebarOpen: vi.fn(),
    setSessionName: vi.fn(),
    setSessionPreview: vi.fn(),
    setSessionTaskHistory: vi.fn(),
    setSessionKeywords: vi.fn(),
    markRecentlyRenamed: vi.fn(),
    clearRecentlyRenamed: vi.fn(),
    setSdkSessions: vi.fn(),
    closeTerminal: vi.fn(),
    openNewSessionModal: vi.fn(),
    closeNewSessionModal: vi.fn(),
    markSessionViewed: vi.fn(),
    markAllSessionsViewed: vi.fn(),
    markSessionUnread: vi.fn(),
    clearSessionAttention: vi.fn(),
    setTreeGroups: vi.fn(),
    ...overrides,
  };
}

// Mock the store module
vi.mock("../store.js", () => {
  // We create a function that acts like the zustand hook with selectors
  const useStoreFn = (selector: (state: MockStoreState) => unknown) => {
    return selector(mockState);
  };
  // Also support useStore.getState() which Sidebar uses directly
  useStoreFn.getState = () => mockState;

  /** countUserPermissions: count permissions excluding evaluating/auto-approved ones */
  const countUserPermissions = (perms: Map<string, unknown> | undefined): number => {
    if (!perms) return 0;
    let count = 0;
    for (const p of perms.values()) {
      const perm = p as { evaluating?: boolean; autoApproved?: string };
      if (!perm?.evaluating && !perm?.autoApproved) count++;
    }
    return count;
  };

  return { useStore: useStoreFn, countUserPermissions };
});

// ─── Import component after mocks ───────────────────────────────────────────

import { Sidebar } from "./Sidebar.js";

// ─── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("alert", mockAlert);
  mockState = createMockState();
  window.location.hash = "";
  setTouchDevice(false);
});

function setTouchDevice(enabled: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: enabled && query === "(hover: none) and (pointer: coarse)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function expectDocumentOrder(nodes: HTMLElement[]) {
  for (let i = 0; i < nodes.length - 1; i++) {
    expect(nodes[i].compareDocumentPosition(nodes[i + 1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
}

describe("Sidebar", { timeout: 10000 }, () => {
  it("polling refreshes sdk sessions without calling connectAllSessions", async () => {
    const listed = [makeSdkSession("s1")];
    mockApi.listSessions.mockResolvedValueOnce(listed);

    render(<Sidebar />);

    await waitFor(() => {
      expect(mockApi.listSessions).toHaveBeenCalled();
      expect(mockState.setSdkSessions).toHaveBeenCalledWith(listed);
    });
    expect(mockConnectAllSessions).not.toHaveBeenCalled();
  });

  it("polling strips search metadata from sdkSessions and skips unchanged task/keyword hydration", async () => {
    const unchangedTasks = [{ title: "Task", action: "new", timestamp: 1, triggerMessageId: "m1" }] as const;
    const unchangedKeywords = ["alpha", "beta"];
    mockState = createMockState({
      sessionTaskHistory: new Map([["s1", [...unchangedTasks]]]),
      sessionKeywords: new Map([["s1", unchangedKeywords]]),
    });

    const listed = [
      makeSdkSession("s1", {
        taskHistory: [...unchangedTasks],
        keywords: [...unchangedKeywords],
      }),
    ];
    mockApi.listSessions.mockResolvedValueOnce(listed);

    render(<Sidebar />);

    await waitFor(() => {
      expect(mockApi.listSessions).toHaveBeenCalled();
      expect(mockState.setSdkSessions).toHaveBeenCalledWith([
        expect.not.objectContaining({
          taskHistory: expect.anything(),
          keywords: expect.anything(),
        }),
      ]);
    });
    expect(mockState.setSessionTaskHistory).not.toHaveBeenCalled();
    expect(mockState.setSessionKeywords).not.toHaveBeenCalled();
  });

  it("polling still strips empty task metadata from sdk sessions", async () => {
    mockState = createMockState({
      sessionTaskHistory: new Map([["s1", [{ title: "Old", action: "new", timestamp: 1, triggerMessageId: "m1" }]]]),
      sessionKeywords: new Map([["s1", ["stale"]]]),
    });

    const listed = [
      makeSdkSession("s1", {
        taskHistory: [],
        keywords: [],
      }),
    ];
    mockApi.listSessions.mockResolvedValue(listed);

    render(<Sidebar />);

    await waitFor(() => {
      expect(mockState.setSdkSessions).toHaveBeenCalledWith([
        expect.not.objectContaining({
          taskHistory: expect.anything(),
          keywords: expect.anything(),
        }),
      ]);
    });
  });

  it("hydrates tree groups from server on mount", async () => {
    // Validates that sidebar fetches tree groups on first render so grouping
    // is correct immediately, without waiting for a WebSocket session connect.
    const groups = [
      { id: "default", name: "Default" },
      { id: "g1", name: "Project A" },
    ];
    const assignments = { s1: "g1" };
    const nodeOrder = { g1: ["s1"] };
    mockApi.getTreeGroups.mockResolvedValueOnce({ groups, assignments, nodeOrder });

    render(<Sidebar />);

    await waitFor(() => {
      expect(mockApi.getTreeGroups).toHaveBeenCalledTimes(1);
    });
    expect(mockState.setTreeGroups).toHaveBeenCalledWith(groups, assignments, nodeOrder);
  });

  it("renders 'New Session' button", () => {
    render(<Sidebar />);
    expect(screen.getByText("New Session")).toBeInTheDocument();
  });

  it("renders 'No sessions yet.' when no sessions exist", () => {
    render(<Sidebar />);
    expect(screen.getByText("No sessions yet.")).toBeInTheDocument();
  });

  it("uses server-side session search when query is non-empty", async () => {
    const session1 = makeSession("s1", { cwd: "/repo/a" });
    const session2 = makeSession("s2", { cwd: "/repo/b" });
    const sdk1 = makeSdkSession("s1", { archived: false, createdAt: 1000 });
    const sdk2 = makeSdkSession("s2", { archived: true, createdAt: 900 });
    mockState = createMockState({
      sessions: new Map([
        ["s1", session1],
        ["s2", session2],
      ]),
      sdkSessions: [sdk1, sdk2],
      sessionNames: new Map([
        ["s1", "Alpha"],
        ["s2", "Archived beta"],
      ]),
    });
    mockApi.searchSessions.mockResolvedValueOnce({
      query: "beta",
      tookMs: 3,
      totalMatches: 1,
      results: [
        {
          sessionId: "s2",
          score: 500,
          matchedField: "user_message",
          matchContext: "message: find beta in archived session",
          matchedAt: 12345,
        },
      ],
    });

    render(<Sidebar />);
    const input = screen.getByPlaceholderText("Search...");
    fireEvent.change(input, { target: { value: "beta" } });

    await waitFor(() => {
      expect(mockApi.searchSessions).toHaveBeenCalledWith(
        "beta",
        expect.objectContaining({
          includeArchived: true,
          signal: expect.any(AbortSignal),
        }),
      );
    });

    expect(screen.getByText("message:")).toBeInTheDocument();
    const highlight = screen.getByText("beta");
    expect(highlight.tagName).toBe("MARK");
    expect(screen.getByText(/find/i)).toBeInTheDocument();
  });

  it("aborts the previous in-flight server search when query changes", async () => {
    const session1 = makeSession("s1", { cwd: "/repo/a" });
    const sdk1 = makeSdkSession("s1", { createdAt: 1000 });
    mockState = createMockState({
      sessions: new Map([["s1", session1]]),
      sdkSessions: [sdk1],
    });

    const signals: AbortSignal[] = [];
    mockApi.searchSessions.mockImplementation(async (_q: string, opts?: { signal?: AbortSignal }) => {
      if (opts?.signal) signals.push(opts.signal);
      // Keep request briefly in-flight so next keystroke aborts it.
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { query: "", tookMs: 1, totalMatches: 0, results: [] };
    });

    render(<Sidebar />);
    const input = screen.getByPlaceholderText("Search...");

    fireEvent.change(input, { target: { value: "alph" } });
    await waitFor(() => expect(mockApi.searchSessions).toHaveBeenCalledTimes(1));

    fireEvent.change(input, { target: { value: "alpha" } });
    await waitFor(() => expect(mockApi.searchSessions).toHaveBeenCalledTimes(2));

    await waitFor(() => expect(signals[0]?.aborted).toBe(true));
  });

  it("renders session items for active sessions", () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1", { model: "claude-sonnet-4-5-20250929" });
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    // The session label defaults to model name
    expect(screen.getByText("claude-sonnet-4-5-20250929")).toBeInTheDocument();
  });

  it("session items show model name or session ID", () => {
    // Session with model name
    const session1 = makeSession("s1", { model: "claude-opus-4-6" });
    const sdk1 = makeSdkSession("s1", { model: "claude-opus-4-6" });

    // Session without model (falls back to short ID)
    const session2 = makeSession("abcdef12-3456-7890-abcd-ef1234567890", { model: "" });
    const sdk2 = makeSdkSession("abcdef12-3456-7890-abcd-ef1234567890", { model: "" });

    mockState = createMockState({
      sessions: new Map([
        ["s1", session1],
        ["abcdef12-3456-7890-abcd-ef1234567890", session2],
      ]),
      sdkSessions: [sdk1, sdk2],
    });

    render(<Sidebar />);
    expect(screen.getByText("claude-opus-4-6")).toBeInTheDocument();
    // Falls back to shortId (first 8 chars)
    expect(screen.getByText("abcdef12")).toBeInTheDocument();
  });

  it("session items show tree group name in the sidebar header", () => {
    const session = makeSession("s1", { cwd: "/home/user/projects/myapp" });
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
      treeGroups: [{ id: "team-alpha", name: "Takode" }],
      treeAssignments: new Map([["s1", "team-alpha"]]),
    });

    render(<Sidebar />);
    expect(screen.getByLabelText("Create session in Takode")).toBeInTheDocument();
  });

  it("session items do not show git branch text when available", () => {
    const session = makeSession("s1", { git_branch: "feature/awesome" });
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    expect(screen.queryByText("feature/awesome")).not.toBeInTheDocument();
  });

  it("session items show container badge when is_containerized is true", () => {
    const session = makeSession("s1", { git_branch: "feature/docker", is_containerized: true });
    const sdk = makeSdkSession("s1", { containerId: "abc123" });
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    expect(screen.getByText("Docker")).toBeInTheDocument();
  });

  it("session items show ahead/behind counts", () => {
    const session = makeSession("s1", {
      git_branch: "main",
      git_ahead: 3,
      git_behind: 2,
    });
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    // The component renders "3↑" and "2↓" using HTML entities in a stats row
    const sessionButton = screen.getByText("claude-sonnet-4-5-20250929").closest("button")!;
    expect(sessionButton.textContent).toContain("3");
    expect(sessionButton.textContent).toContain("2");
  });

  it("session items show lines added/removed", () => {
    // Line stats come from server (single source of truth via bridgeState)
    const session = makeSession("s1", {
      git_branch: "main",
      total_lines_added: 42,
      total_lines_removed: 7,
    });
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    expect(screen.getByText("+42")).toBeInTheDocument();
    expect(screen.getByText("-7")).toBeInTheDocument();
  });

  it("worktree sessions show both behind/ahead counts and line diff stats", () => {
    // Worktree chips should show base sync status (behind/ahead) and the
    // stable agent diff totals at the same time.
    const session = makeSession("s1", {
      git_branch: "jiayi-wt-9954",
      is_worktree: true,
      git_ahead: 0,
      git_behind: 0, // stale bridge value
      total_lines_added: 167,
      total_lines_removed: 858,
    });
    const sdk = makeSdkSession("s1", { gitBehind: 6 });
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    const sessionButton = screen.getByText("claude-sonnet-4-5-20250929").closest("button")!;
    expect(screen.getByText("wt")).toBeInTheDocument();
    expect(sessionButton.textContent).toContain("6↓");
    expect(sessionButton.textContent).toContain("+167");
    expect(sessionButton.textContent).toContain("-858");
  });

  it("falls back to local diff file stats when server line totals are temporarily zero", () => {
    const session = makeSession("s1", {
      git_branch: "jiayi-wt-9954",
      is_worktree: true,
      total_lines_added: 0,
      total_lines_removed: 0,
    });
    const sdk = makeSdkSession("s1", { totalLinesAdded: 0, totalLinesRemoved: 0 });
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
      diffFileStats: new Map([
        ["s1", new Map([["/repo/docs/codex-dropped-user-messages.md", { additions: 1527, deletions: 625 }]])],
      ]),
    });

    render(<Sidebar />);
    const sessionButton = screen.getByText("claude-sonnet-4-5-20250929").closest("button")!;
    expect(sessionButton.textContent).toContain("+1527");
    expect(sessionButton.textContent).toContain("-625");
  });

  it("active session has highlighted styling (bg-cc-active class)", () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
      currentSessionId: "s1",
    });

    render(<Sidebar />);
    // Find the session button element
    const sessionButton = screen.getByText("claude-sonnet-4-5-20250929").closest("button");
    expect(sessionButton).toHaveClass("bg-cc-active");
  });

  it("clicking a session navigates to the session hash", () => {
    // Sidebar now delegates to URL-based routing: it sets the hash to #/session/{id}
    // and App.tsx's hash effect handles setCurrentSession + connectSession
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
      currentSessionId: null,
    });

    render(<Sidebar />);
    const sessionButton = screen.getByText("claude-sonnet-4-5-20250929").closest("button")!;
    fireEvent.click(sessionButton);

    expect(window.location.hash).toBe("#/session/s1");
  });

  it("New Session button opens new session modal", () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByText("New Session"));

    // handleNewSession opens the modal without group context
    expect(mockState.openNewSessionModal).toHaveBeenCalledWith();
  });

  it("default tree group plus button opens new session modal with tree defaults", () => {
    const session = makeSession("s1", {
      cwd: "/home/user/projects/myapp",
      repo_root: "/home/user/projects/myapp",
    });
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    fireEvent.click(screen.getByLabelText("Create session in Default"));

    expect(mockState.openNewSessionModal).toHaveBeenCalledWith({
      treeGroupId: "default",
      newSessionDefaultsKey: "tree-group:default",
    });
  });

  it("tree group plus button opens new session modal with a tree-scoped defaults key", () => {
    const session = makeSession("s1", {
      cwd: "/home/user/projects/myapp",
      repo_root: "/home/user/projects/myapp",
    });
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
      treeGroups: [{ id: "team-alpha", name: "Takode" }],
      treeAssignments: new Map([["s1", "team-alpha"]]),
    });

    render(<Sidebar />);
    fireEvent.click(screen.getByLabelText("Create session in Takode"));

    expect(mockState.openNewSessionModal).toHaveBeenCalledWith({
      treeGroupId: "team-alpha",
      newSessionDefaultsKey: "tree-group:team-alpha",
    });
  });

  it("does not render the old sidebar view mode toggle", () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);

    expect(screen.queryByTitle("Tree view (herd groups)")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Linear view (project groups)")).not.toBeInTheDocument();
  });

  it("double-clicking a session enters edit mode", async () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    const sessionButton = screen.getByText("claude-sonnet-4-5-20250929").closest("button")!;
    fireEvent.doubleClick(sessionButton);

    // After double-click, an input should appear for renaming
    const input = await screen.findByDisplayValue("claude-sonnet-4-5-20250929");
    expect(input).toBeInTheDocument();
    expect(input.tagName).toBe("INPUT");
  });

  it("archive button exists in the DOM for session items", () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    // Archive button has title "Archive session"
    const archiveButton = screen.getByTitle("Archive session");
    expect(archiveButton).toBeInTheDocument();
  });

  it("archive action button is visible by default on mobile and hover-only on desktop", () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    const archiveButton = screen.getByTitle("Archive session");
    const sessionButton = screen.getByText("claude-sonnet-4-5-20250929").closest("button");

    expect(archiveButton).toHaveClass("opacity-100");
    expect(archiveButton).toHaveClass("sm:opacity-0");
    expect(archiveButton).toHaveClass("sm:group-hover:opacity-100");
    expect(archiveButton).toHaveClass("left-1");
    // Archive button overlays on the left side on desktop (no reserved padding — overlays existing pl-3.5)
    expect(sessionButton).toHaveClass("sm:pl-3.5");
  });

  it("non-leader archive button still archives immediately", async () => {
    const session = makeSession("s1", { model: "solo-session" });
    const sdk = makeSdkSession("s1", { model: "solo-session" });
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    const sessionButton = screen.getByText("solo-session").closest("button")!;
    const row = sessionButton.parentElement as HTMLElement;
    fireEvent.click(within(row).getByTitle("Archive session"));

    await waitFor(() => {
      expect(mockApi.archiveSession).toHaveBeenCalledWith("s1", undefined);
    });
    expect(screen.queryByText(/detach 1 active worker session/i)).not.toBeInTheDocument();
  });

  it("leader archive button requires confirmation while workers are still active", async () => {
    const leader = makeSession("leader-1", { model: "leader-session" });
    const worker = makeSession("worker-1", { model: "worker-session" });
    const leaderSdk = makeSdkSession("leader-1", { model: "leader-session", isOrchestrator: true, createdAt: 2_000 });
    const workerSdk = makeSdkSession("worker-1", { model: "worker-session", herdedBy: "leader-1", createdAt: 1_000 });
    mockState = createMockState({
      sessions: new Map([
        ["leader-1", leader],
        ["worker-1", worker],
      ]),
      sdkSessions: [leaderSdk, workerSdk],
    });

    render(<Sidebar />);
    const leaderButton = screen.getByText("leader-session").closest("button")!;
    const row = leaderButton.parentElement as HTMLElement;

    fireEvent.click(within(row).getByTitle("Archive session"));

    expect(mockApi.archiveSession).not.toHaveBeenCalled();
    expect(screen.getByText(/detach 1 active worker session/i)).toBeInTheDocument();

    fireEvent.click(within(row).getByRole("button", { name: "Archive" }));

    await waitFor(() => {
      expect(mockApi.archiveSession).toHaveBeenCalledWith("leader-1", { force: true });
    });
  });

  it("leader swipe archive requires confirmation instead of archiving immediately", () => {
    const leader = makeSession("leader-1", { model: "leader-session" });
    const worker = makeSession("worker-1", { model: "worker-session" });
    const leaderSdk = makeSdkSession("leader-1", { model: "leader-session", isOrchestrator: true, createdAt: 2_000 });
    const workerSdk = makeSdkSession("worker-1", { model: "worker-session", herdedBy: "leader-1", createdAt: 1_000 });
    mockState = createMockState({
      sessions: new Map([
        ["leader-1", leader],
        ["worker-1", worker],
      ]),
      sdkSessions: [leaderSdk, workerSdk],
    });

    render(<Sidebar />);
    const leaderButton = screen.getByText("leader-session").closest("button")!;

    fireEvent.touchStart(leaderButton, { touches: [{ clientX: 80, clientY: 40 }] });
    fireEvent.touchMove(leaderButton, { touches: [{ clientX: 170, clientY: 42 }] });
    fireEvent.touchEnd(leaderButton);

    expect(mockApi.archiveSession).not.toHaveBeenCalled();
    expect(screen.getByText(/detach 1 active worker session/i)).toBeInTheDocument();
  });

  it("context-menu archive uses the same leader confirmation safeguard", () => {
    const leader = makeSession("leader-1", { model: "leader-session" });
    const worker = makeSession("worker-1", { model: "worker-session" });
    const leaderSdk = makeSdkSession("leader-1", { model: "leader-session", isOrchestrator: true, createdAt: 2_000 });
    const workerSdk = makeSdkSession("worker-1", { model: "worker-session", herdedBy: "leader-1", createdAt: 1_000 });
    mockState = createMockState({
      sessions: new Map([
        ["leader-1", leader],
        ["worker-1", worker],
      ]),
      sdkSessions: [leaderSdk, workerSdk],
    });

    render(<Sidebar />);
    const leaderButton = screen.getByText("leader-session").closest("button")!;

    fireEvent.contextMenu(leaderButton, { clientX: 100, clientY: 120 });
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    expect(mockApi.archiveSession).not.toHaveBeenCalled();
    expect(screen.queryByText("Delete Session")).not.toBeInTheDocument();
    expect(screen.getByText(/detach 1 active worker session/i)).toBeInTheDocument();
  });

  it("permission badge uses mobile-friendly positioning and hover behavior", () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
      pendingPermissions: new Map([["s1", new Map([["p1", {}]])]]),
    });

    render(<Sidebar />);
    const mobilePermissionBadge = screen
      .getAllByText("1")
      .find((node) => node.classList.contains("bg-cc-warning") && node.classList.contains("px-1"))!;
    expect(mobilePermissionBadge).toHaveClass("right-11");
    expect(mobilePermissionBadge).toHaveClass("sm:right-2");
    expect(mobilePermissionBadge).toHaveClass("sm:group-hover:opacity-0");
  });

  it("shows mobile Edit/Done reorder toggle", () => {
    const session1 = makeSession("s1");
    const session2 = makeSession("s2");
    const sdk1 = makeSdkSession("s1");
    const sdk2 = makeSdkSession("s2");
    mockState = createMockState({
      sessions: new Map([
        ["s1", session1],
        ["s2", session2],
      ]),
      sdkSessions: [sdk1, sdk2],
    });

    render(<Sidebar />);

    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reorder" })).not.toBeInTheDocument();
  });

  it("shows Done label when reorder mode is active", () => {
    const session1 = makeSession("s1");
    const session2 = makeSession("s2");
    const sdk1 = makeSdkSession("s1");
    const sdk2 = makeSdkSession("s2");
    mockState = createMockState({
      sessions: new Map([
        ["s1", session1],
        ["s2", session2],
      ]),
      sdkSessions: [sdk1, sdk2],
      reorderMode: true,
    });

    render(<Sidebar />);
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it("renders a mobile dismiss button that closes the sidebar explicitly", () => {
    render(<Sidebar />);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss sidebar" }));

    expect(mockState.setSidebarOpen).toHaveBeenCalledWith(false);
  });

  it("keeps the mobile session scroller vertically scrollable by default and locks it while a reorder handle is held", async () => {
    setTouchDevice(true);
    const session1 = makeSession("s1");
    const session2 = makeSession("s2");
    const sdk1 = makeSdkSession("s1");
    const sdk2 = makeSdkSession("s2");
    mockState = createMockState({
      sessions: new Map([
        ["s1", session1],
        ["s2", session2],
      ]),
      sdkSessions: [sdk1, sdk2],
      reorderMode: true,
    });

    render(<Sidebar />);

    const scroller = screen.getByTestId("sidebar-session-scroller");
    expect(scroller).toHaveClass("overflow-y-auto");
    expect(scroller).toHaveClass("overflow-x-hidden");
    expect(scroller).toHaveStyle({ touchAction: "pan-y" });

    fireEvent.touchStart(screen.getByTestId("session-drag-handle-s1"));
    await waitFor(() => {
      expect(scroller).toHaveClass("overflow-y-hidden");
      expect(scroller).toHaveStyle({ touchAction: "none" });
    });

    fireEvent.touchEnd(window);
    await waitFor(() => {
      expect(scroller).toHaveClass("overflow-y-auto");
      expect(scroller).toHaveStyle({ touchAction: "pan-y" });
    });
  });

  it("archived sessions section shows count", () => {
    const sdk1 = makeSdkSession("s1", { archived: false });
    const sdk2 = makeSdkSession("s2", { archived: true });
    const sdk3 = makeSdkSession("s3", { archived: true });

    mockState = createMockState({
      sdkSessions: [sdk1, sdk2, sdk3],
    });

    render(<Sidebar />);
    // The component renders "Archived (2)"
    expect(screen.getByText(/Archived \(2\)/)).toBeInTheDocument();
  });

  it("hides archived delete button on mobile cards (delete via context menu)", () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1", { archived: true });
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    fireEvent.click(screen.getByText(/Archived \(1\)/));

    const deleteButton = screen.getByTitle("Delete permanently");
    expect(deleteButton).toHaveClass("hidden");
    expect(deleteButton).toHaveClass("sm:block");
  });

  it("toggle archived shows/hides archived sessions", () => {
    const sdk1 = makeSdkSession("s1", { archived: false, model: "active-model" });
    const sdk2 = makeSdkSession("s2", { archived: true, model: "archived-model" });

    mockState = createMockState({
      sdkSessions: [sdk1, sdk2],
    });

    render(<Sidebar />);

    // Archived sessions should not be visible initially
    expect(screen.queryByText("archived-model")).not.toBeInTheDocument();

    // Click the archived toggle button
    const toggleButton = screen.getByText(/Archived \(1\)/);
    fireEvent.click(toggleButton);

    // Now the archived session should be visible
    expect(screen.getByText("archived-model")).toBeInTheDocument();
  });

  it("does not render settings controls directly in sidebar", () => {
    render(<Sidebar />);
    expect(screen.queryByText("Notification")).not.toBeInTheDocument();
    expect(screen.queryByText("Dark mode")).not.toBeInTheDocument();
  });

  // Footer nav buttons are icon-only with title attributes for tooltips
  it("navigates to settings page when Settings is clicked", () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByTitle("Settings"));
    expect(window.location.hash).toBe("#/settings");
  });

  it("navigates to terminal page when Terminal is clicked", () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByTitle("Terminal"));
    expect(window.location.hash).toBe("#/terminal");
  });

  it("session name shows animate-name-appear class when recently renamed", () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
      sessionNames: new Map([["s1", "Auto Generated Title"]]),
      recentlyRenamed: new Set(["s1"]),
    });

    render(<Sidebar />);
    const nameElement = screen.getByText("Auto Generated Title");
    // Animation class is on the parent span wrapper, not the inner text span
    expect(nameElement.closest(".animate-name-appear")).toBeTruthy();
  });

  it("session name does NOT have animate-name-appear when not recently renamed", () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
      sessionNames: new Map([["s1", "Regular Name"]]),
      recentlyRenamed: new Set(), // not recently renamed
    });

    render(<Sidebar />);
    const nameElement = screen.getByText("Regular Name");
    expect(nameElement.className).not.toContain("animate-name-appear");
  });

  it("calls clearRecentlyRenamed on animation end", () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
      sessionNames: new Map([["s1", "Animated Name"]]),
      recentlyRenamed: new Set(["s1"]),
    });

    const { container } = render(<Sidebar />);
    // The animated span has the animate-name-appear class and an onAnimationEnd
    // handler that calls onClearRecentlyRenamed(sessionId).
    const animatedSpan = container.querySelector(".animate-name-appear");
    expect(animatedSpan).toBeTruthy();

    // JSDOM does not define AnimationEvent in all environments, which
    // causes fireEvent.animationEnd to silently fail. We traverse the
    // React fiber tree to invoke the onAnimationEnd handler directly.
    const fiberKey = Object.keys(animatedSpan!).find((k) => k.startsWith("__reactFiber$"));
    expect(fiberKey).toBeDefined();
    let fiber = (animatedSpan as unknown as Record<string, unknown>)[fiberKey!] as Record<string, unknown> | null;
    let called = false;
    while (fiber) {
      const props = fiber.memoizedProps as Record<string, unknown> | undefined;
      if (props?.onAnimationEnd) {
        (props.onAnimationEnd as () => void)();
        called = true;
        break;
      }
      fiber = fiber.return as Record<string, unknown> | null;
    }
    expect(called).toBe(true);
    expect(mockState.clearRecentlyRenamed).toHaveBeenCalledWith("s1");
  });

  it("animation class applies only to the recently renamed session, not others", () => {
    const session1 = makeSession("s1");
    const session2 = makeSession("s2");
    const sdk1 = makeSdkSession("s1");
    const sdk2 = makeSdkSession("s2");
    mockState = createMockState({
      sessions: new Map([
        ["s1", session1],
        ["s2", session2],
      ]),
      sdkSessions: [sdk1, sdk2],
      sessionNames: new Map([
        ["s1", "Renamed Session"],
        ["s2", "Other Session"],
      ]),
      recentlyRenamed: new Set(["s1"]), // only s1 was renamed
    });

    render(<Sidebar />);
    const renamedElement = screen.getByText("Renamed Session");
    const otherElement = screen.getByText("Other Session");

    // Animation class is on the parent span wrapper, not the inner text span
    expect(renamedElement.closest(".animate-name-appear")).toBeTruthy();
    expect(otherElement.closest(".animate-name-appear")).toBeFalsy();
  });

  it("permission badge shows count for sessions with pending permissions", () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    const permMap = new Map<string, unknown>([
      ["r1", { request_id: "r1", tool_name: "Bash" }],
      ["r2", { request_id: "r2", tool_name: "Read" }],
    ]);
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
      pendingPermissions: new Map([["s1", permMap as Map<string, unknown>]]),
      cliConnected: new Map([["s1", true]]),
    });

    render(<Sidebar />);
    // The permission count badge shows "2"
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("session keeps git stats but hides git branch text when bridgeState is unavailable", () => {
    // No bridgeState — only sdkInfo (REST API) data available.
    // Line stats come from server via sdkInfo (single source of truth).
    const sdk = makeSdkSession("s1", {
      gitBranch: "feature/from-rest",
      gitAhead: 5,
      gitBehind: 2,
      totalLinesAdded: 100,
      totalLinesRemoved: 20,
    });
    mockState = createMockState({
      sessions: new Map(), // no bridge state
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    expect(screen.queryByText("feature/from-rest")).not.toBeInTheDocument();
    const sessionButton = screen.getByText("+100").closest("button")!;
    expect(sessionButton.textContent).toContain("5");
    expect(sessionButton.textContent).toContain("2");
    expect(sessionButton.textContent).toContain("+100");
    expect(sessionButton.textContent).toContain("-20");
  });

  it("session prefers bridgeState git stats over sdkInfo", () => {
    const session = makeSession("s1", {
      git_branch: "from-bridge",
      git_ahead: 1,
    });
    const sdk = makeSdkSession("s1", {
      gitBranch: "from-rest",
      gitAhead: 99,
    });
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    // Bridge stats should win over REST API stats
    expect(screen.queryByText("from-bridge")).not.toBeInTheDocument();
    expect(screen.queryByText("from-rest")).not.toBeInTheDocument();
    const sessionButton = screen.getByText("1↑").closest("button")!;
    expect(sessionButton.textContent).toContain("1");
    expect(sessionButton.textContent).not.toContain("99");
  });

  it("codex session shows Codex icon when bridgeState is missing", () => {
    // Only sdkInfo available (no WS session_init received yet)
    const sdk = makeSdkSession("s1", { backendType: "codex" });
    mockState = createMockState({
      sessions: new Map(), // no bridge state
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    // Should show Codex backend icon
    expect(screen.getByAltText("Codex")).toBeInTheDocument();
  });

  it("session shows correct backend icon based on backendType", () => {
    const session1 = makeSession("s1", { backend_type: "claude" });
    const session2 = makeSession("s2", { backend_type: "codex" });
    const sdk1 = makeSdkSession("s1", { backendType: "claude" });
    const sdk2 = makeSdkSession("s2", { backendType: "codex" });
    mockState = createMockState({
      sessions: new Map([
        ["s1", session1],
        ["s2", session2],
      ]),
      sdkSessions: [sdk1, sdk2],
    });

    render(<Sidebar />);
    // Both backend icons should be present
    const claudeIcons = screen.getAllByAltText("Claude");
    const codexIcons = screen.getAllByAltText("Codex");
    expect(claudeIcons.length).toBeGreaterThanOrEqual(1);
    expect(codexIcons.length).toBeGreaterThanOrEqual(1);
  });

  it("sessions are grouped by project directory", () => {
    const session1 = makeSession("s1", { cwd: "/home/user/project-a" });
    const session2 = makeSession("s2", { cwd: "/home/user/project-a" });
    const session3 = makeSession("s3", { cwd: "/home/user/project-b" });
    const sdk1 = makeSdkSession("s1", { cwd: "/home/user/project-a" });
    const sdk2 = makeSdkSession("s2", { cwd: "/home/user/project-a" });
    const sdk3 = makeSdkSession("s3", { cwd: "/home/user/project-b" });
    mockState = createMockState({
      sessions: new Map([
        ["s1", session1],
        ["s2", session2],
        ["s3", session3],
      ]),
      sdkSessions: [sdk1, sdk2, sdk3],
      treeGroups: [
        { id: "alpha", name: "Alpha" },
        { id: "beta", name: "Beta" },
      ],
      treeAssignments: new Map([
        ["s1", "alpha"],
        ["s2", "alpha"],
        ["s3", "beta"],
      ]),
    });

    render(<Sidebar />);
    // Tree group headers should be visible for the assigned herd groups.
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("tree group header shows running count as colored dot", () => {
    const session1 = makeSession("s1", { cwd: "/home/user/myapp" });
    const session2 = makeSession("s2", { cwd: "/home/user/myapp" });
    const sdk1 = makeSdkSession("s1", { cwd: "/home/user/myapp" });
    const sdk2 = makeSdkSession("s2", { cwd: "/home/user/myapp" });
    mockState = createMockState({
      sessions: new Map([
        ["s1", session1],
        ["s2", session2],
      ]),
      sdkSessions: [sdk1, sdk2],
      sessionStatus: new Map([
        ["s1", "running"],
        ["s2", "running"],
      ]),
      cliConnected: new Map([
        ["s1", true],
        ["s2", true],
      ]),
      treeGroups: [{ id: "team-alpha", name: "Takode" }],
      treeAssignments: new Map([
        ["s1", "team-alpha"],
        ["s2", "team-alpha"],
      ]),
    });

    const { container } = render(<Sidebar />);
    // Status is now shown as colored number + dot (e.g. "2●") not "2 running"
    const greenDots = container.querySelectorAll(".bg-cc-success.rounded-full");
    expect(greenDots.length).toBeGreaterThanOrEqual(1);
  });

  it("collapsing a tree group hides its sessions", () => {
    const session = makeSession("s1", { cwd: "/home/user/myapp", model: "hidden-model" });
    const sdk = makeSdkSession("s1", { cwd: "/home/user/myapp" });
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
      treeGroups: [{ id: "team-alpha", name: "Takode" }],
      treeAssignments: new Map([["s1", "team-alpha"]]),
      collapsedTreeGroups: new Set(["team-alpha"]),
    });

    render(<Sidebar />);
    expect(screen.getByLabelText("Create session in Takode")).toBeInTheDocument();
    // But the session inside it should be hidden
    expect(screen.queryByText("hidden-model")).not.toBeInTheDocument();
  });

  it("context menu supports copy actions and confirms delete", async () => {
    const createdAt = 1700000000000;
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1", { cliSessionId: "cli-abc-123", createdAt });
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
      currentSessionId: "s1",
    });

    render(<Sidebar />);
    const sessionButton = screen.getByText("claude-sonnet-4-5-20250929").closest("button")!;
    fireEvent.contextMenu(sessionButton, { clientX: 100, clientY: 120 });

    expect(screen.getByText("Copy Session ID")).toBeInTheDocument();
    expect(screen.getByText("Copy CLI Session ID")).toBeInTheDocument();
    expect(screen.getByText("Delete Session")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Copy Session ID"));
    expect(mockWriteClipboardText).toHaveBeenCalledWith("s1");

    fireEvent.contextMenu(sessionButton, { clientX: 110, clientY: 125 });
    fireEvent.click(screen.getByText("Delete Session"));
    expect(screen.getByText("Delete session permanently?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(mockApi.deleteSession).toHaveBeenCalledWith("s1");
    });
  });

  it("offers a force-herd action to the current leader for workers owned by another leader", async () => {
    // Workers already owned by a different leader should expose the explicit
    // force-takeover affordance, including the confirmation gate.
    const leaderSession = makeSession("leader-1");
    const workerSession = makeSession("worker-1");
    const otherLeaderSession = makeSession("leader-9");
    const leaderSdk = makeSdkSession("leader-1", { isOrchestrator: true, sessionNum: 1 });
    const workerSdk = makeSdkSession("worker-1", { herdedBy: "leader-9", sessionNum: 7 });
    const otherLeaderSdk = makeSdkSession("leader-9", { isOrchestrator: true, sessionNum: 9 });
    mockState = createMockState({
      sessions: new Map([
        ["leader-1", leaderSession],
        ["worker-1", workerSession],
        ["leader-9", otherLeaderSession],
      ]),
      sdkSessions: [leaderSdk, workerSdk, otherLeaderSdk],
      currentSessionId: "leader-1",
      sessionNames: new Map([
        ["leader-1", "Current Leader"],
        ["worker-1", "Target Worker"],
        ["leader-9", "Previous Leader"],
      ]),
      expandedHerdNodes: new Set(["leader-9"]),
    });

    render(<Sidebar />);
    const sessionButton = screen.getByText("Target Worker").closest("button")!;
    fireEvent.contextMenu(sessionButton, { clientX: 100, clientY: 120 });

    fireEvent.click(screen.getByText("Force Herd to Current Session"));
    expect(screen.getByText("Force herd takeover?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Force Herd" }));

    await waitFor(() => {
      expect(mockApi.herdWorkerToLeader).toHaveBeenCalledWith("worker-1", "leader-1", { force: true });
    });
  });

  it("offers a plain herd action without confirmation for unowned workers", async () => {
    // Ordinary herd actions must remain distinct from force takeover so the UI
    // does not silently upgrade every herd to a forced reassignment.
    const leaderSession = makeSession("leader-1");
    const workerSession = makeSession("worker-2");
    const leaderSdk = makeSdkSession("leader-1", { isOrchestrator: true, sessionNum: 1 });
    const workerSdk = makeSdkSession("worker-2", { sessionNum: 8 });
    mockState = createMockState({
      sessions: new Map([
        ["leader-1", leaderSession],
        ["worker-2", workerSession],
      ]),
      sdkSessions: [leaderSdk, workerSdk],
      currentSessionId: "leader-1",
      sessionNames: new Map([
        ["leader-1", "Current Leader"],
        ["worker-2", "Fresh Worker"],
      ]),
    });

    render(<Sidebar />);
    const sessionButton = screen.getByText("Fresh Worker").closest("button")!;
    fireEvent.contextMenu(sessionButton, { clientX: 100, clientY: 120 });

    fireEvent.click(screen.getByText("Herd to Current Session"));
    expect(screen.queryByText("Force herd takeover?")).toBeNull();

    await waitFor(() => {
      expect(mockApi.herdWorkerToLeader).toHaveBeenCalledWith("worker-2", "leader-1", undefined);
    });
  });

  it("alerts the user when the herd action fails", async () => {
    // Browser herd failures must be visible to the user instead of being
    // swallowed silently by the context-menu action.
    mockApi.herdWorkerToLeader.mockRejectedValueOnce(new Error("Session is already herded by leader-9"));

    const leaderSession = makeSession("leader-1");
    const workerSession = makeSession("worker-2");
    const leaderSdk = makeSdkSession("leader-1", { isOrchestrator: true, sessionNum: 1 });
    const workerSdk = makeSdkSession("worker-2", { sessionNum: 8 });
    mockState = createMockState({
      sessions: new Map([
        ["leader-1", leaderSession],
        ["worker-2", workerSession],
      ]),
      sdkSessions: [leaderSdk, workerSdk],
      currentSessionId: "leader-1",
      sessionNames: new Map([
        ["leader-1", "Current Leader"],
        ["worker-2", "Fresh Worker"],
      ]),
    });

    render(<Sidebar />);
    const sessionButton = screen.getByText("Fresh Worker").closest("button")!;
    fireEvent.contextMenu(sessionButton, { clientX: 100, clientY: 120 });
    fireEvent.click(screen.getByText("Herd to Current Session"));

    await waitFor(() => {
      expect(mockAlert).toHaveBeenCalledWith("Session is already herded by leader-9");
    });
  });

  it("hover card shows both session IDs and created time", async () => {
    const createdAt = 1700000000000;
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1", { cliSessionId: "cli-abc-123", createdAt });
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
      currentSessionId: "s1",
    });

    render(<Sidebar />);
    const sessionButton = screen.getByText("claude-sonnet-4-5-20250929").closest("button")!;
    fireEvent.mouseEnter(sessionButton);

    await waitFor(() => {
      expect(screen.getByTitle("s1")).toBeInTheDocument();
      expect(screen.getByTitle("cli-abc-123")).toBeInTheDocument();
      expect(screen.getByTitle(new Date(createdAt).toLocaleString())).toBeInTheDocument();
    });
  });

  it("reviewer badge hover switches the hover card to the reviewer session", async () => {
    // q-340: the inline reviewer chip should act as its own hover target so
    // the shared hover card shows reviewer details rather than the reviewed parent.
    const parentSession = makeSession("parent-1");
    const reviewerSession = makeSession("reviewer-1");
    const parentSdk = makeSdkSession("parent-1", {
      sessionNum: 8,
      createdAt: 1700000000000,
      cliSessionId: "cli-parent-1",
    });
    const reviewerSdk = makeSdkSession("reviewer-1", {
      sessionNum: 42,
      createdAt: 1700000001000,
      cliSessionId: "cli-reviewer-1",
      reviewerOf: 8,
    });
    mockState = createMockState({
      sessions: new Map([
        ["parent-1", parentSession],
        ["reviewer-1", reviewerSession],
      ]),
      sdkSessions: [parentSdk, reviewerSdk],
      sessionNames: new Map([
        ["parent-1", "Parent Session"],
        ["reviewer-1", "Reviewer Session"],
      ]),
    });

    render(<Sidebar />);

    const parentButton = screen.getByText("Parent Session").closest("button")!;
    fireEvent.mouseEnter(parentButton);

    await waitFor(() => {
      expect(screen.getByTitle("parent-1")).toBeInTheDocument();
    });

    fireEvent.mouseEnter(within(parentButton).getByTestId("session-reviewer-badge"));

    await waitFor(() => {
      expect(screen.getByTitle("reviewer-1")).toBeInTheDocument();
      expect(screen.getByTitle("cli-reviewer-1")).toBeInTheDocument();
    });

    expect(screen.queryByTitle("parent-1")).toBeNull();
  });

  it("shows a bounded task-history scroller in session hover card", async () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
      sessionTaskHistory: new Map([
        [
          "s1",
          Array.from({ length: 20 }, (_, i) => ({
            title: ` Task ${i + 1} `,
            action: "claim",
            timestamp: Date.now() + i,
          })),
        ],
      ]),
    });

    render(<Sidebar />);
    const sessionButton = screen.getByText("claude-sonnet-4-5-20250929").closest("button")!;
    fireEvent.mouseEnter(sessionButton);

    await waitFor(() => {
      const scroller = screen.getByTestId("session-hover-task-history-scroll");
      expect(scroller).toHaveClass("max-h-40");
      expect(scroller).toHaveClass("overflow-y-auto");
    });
  });

  it("hovering a herded worker highlights its leader and shows leader info in hover card", async () => {
    const leaderSessionId = "leader-1";
    const workerSessionId = "worker-1";
    const leaderSession = makeSession(leaderSessionId, { model: "leader-model" });
    const workerSession = makeSession(workerSessionId, { model: "worker-model" });
    const leaderSdk = makeSdkSession(leaderSessionId, {
      isOrchestrator: true,
      sessionNum: 7,
      createdAt: 1700000000000,
    });
    const workerSdk = makeSdkSession(workerSessionId, {
      herdedBy: leaderSessionId,
      sessionNum: 11,
      createdAt: 1700000001000,
    });
    mockState = createMockState({
      sessions: new Map([
        [leaderSessionId, leaderSession],
        [workerSessionId, workerSession],
      ]),
      sdkSessions: [leaderSdk, workerSdk],
      sessionNames: new Map([
        [leaderSessionId, "Leader Session"],
        [workerSessionId, "Worker Session"],
      ]),
      expandedHerdNodes: new Set([leaderSessionId]),
    });

    render(<Sidebar />);
    const workerButton = screen.getByText("Worker Session").closest("button")!;
    fireEvent.mouseEnter(workerButton);

    await waitFor(() => {
      expect(screen.getByText("Herded by")).toBeInTheDocument();
      const section = screen.getByTestId("session-hover-herded-by");
      expect(within(section).getByRole("button", { name: "#7" })).toBeInTheDocument();
    });
  });

  it("keeps workers grouped under the correct leader when multiple herds are expanded", () => {
    const leaderAlphaId = "leader-alpha";
    const workerAlphaId = "worker-alpha";
    const leaderBetaId = "leader-beta";
    const workerBetaId = "worker-beta";
    mockState = createMockState({
      sessions: new Map([
        [leaderAlphaId, makeSession(leaderAlphaId, { model: "leader-alpha-model" })],
        [workerAlphaId, makeSession(workerAlphaId, { model: "worker-alpha-model" })],
        [leaderBetaId, makeSession(leaderBetaId, { model: "leader-beta-model" })],
        [workerBetaId, makeSession(workerBetaId, { model: "worker-beta-model" })],
      ]),
      sdkSessions: [
        makeSdkSession(leaderAlphaId, { isOrchestrator: true, sessionNum: 7, createdAt: 1700000001000 }),
        makeSdkSession(workerAlphaId, { herdedBy: leaderAlphaId, sessionNum: 8, createdAt: 1700000002000 }),
        makeSdkSession(leaderBetaId, { isOrchestrator: true, sessionNum: 9, createdAt: 1700000003000 }),
        makeSdkSession(workerBetaId, { herdedBy: leaderBetaId, sessionNum: 10, createdAt: 1700000004000 }),
      ],
      sessionNames: new Map([
        [leaderAlphaId, "Leader Alpha"],
        [workerAlphaId, "Worker Alpha"],
        [leaderBetaId, "Leader Beta"],
        [workerBetaId, "Worker Beta"],
      ]),
      expandedHerdNodes: new Set([leaderAlphaId, leaderBetaId]),
    });

    render(<Sidebar />);

    const leaderAlphaButton = screen.getByText("Leader Alpha").closest("button")!;
    const workerAlphaButton = screen.getByText("Worker Alpha").closest("button")!;
    const leaderBetaButton = screen.getByText("Leader Beta").closest("button")!;
    const workerBetaButton = screen.getByText("Worker Beta").closest("button")!;

    expect(leaderAlphaButton.compareDocumentPosition(workerAlphaButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(leaderBetaButton.compareDocumentPosition(workerBetaButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("does not add redundant herd highlight rings when leader info panel is open in tree view", () => {
    const leaderSessionId = "leader-2";
    const workerSessionId = "worker-2";
    const leaderSession = makeSession(leaderSessionId, { model: "leader-open-model" });
    const workerSession = makeSession(workerSessionId, { model: "worker-open-model" });
    const leaderSdk = makeSdkSession(leaderSessionId, {
      isOrchestrator: true,
      sessionNum: 21,
      createdAt: 1700000002000,
    });
    const workerSdk = makeSdkSession(workerSessionId, {
      herdedBy: leaderSessionId,
      sessionNum: 22,
      createdAt: 1700000003000,
    });
    mockState = createMockState({
      sessions: new Map([
        [leaderSessionId, leaderSession],
        [workerSessionId, workerSession],
      ]),
      sdkSessions: [leaderSdk, workerSdk],
      sessionNames: new Map([
        [leaderSessionId, "Leader Open"],
        [workerSessionId, "Worker Open"],
      ]),
      sessionInfoOpenSessionId: leaderSessionId,
      expandedHerdNodes: new Set([leaderSessionId]),
    });

    render(<Sidebar />);
    const workerButton = screen.getByText("Worker Open").closest("button");
    expect(workerButton).not.toHaveClass("ring-amber-400/45");
  });

  it("does not add redundant herd highlight rings when worker info panel is open in tree view", () => {
    const leaderSessionId = "leader-3";
    const workerSessionId = "worker-3";
    const leaderSession = makeSession(leaderSessionId, { model: "leader-worker-open-model" });
    const workerSession = makeSession(workerSessionId, { model: "worker-worker-open-model" });
    const leaderSdk = makeSdkSession(leaderSessionId, {
      isOrchestrator: true,
      sessionNum: 31,
      createdAt: 1700000004000,
    });
    const workerSdk = makeSdkSession(workerSessionId, {
      herdedBy: leaderSessionId,
      sessionNum: 32,
      createdAt: 1700000005000,
    });
    mockState = createMockState({
      sessions: new Map([
        [leaderSessionId, leaderSession],
        [workerSessionId, workerSession],
      ]),
      sdkSessions: [leaderSdk, workerSdk],
      sessionNames: new Map([
        [leaderSessionId, "Leader Worker Open"],
        [workerSessionId, "Worker Worker Open"],
      ]),
      sessionInfoOpenSessionId: workerSessionId,
      expandedHerdNodes: new Set([leaderSessionId]),
    });

    render(<Sidebar />);
    const leaderButton = screen.getByText("Leader Worker Open").closest("button");
    expect(leaderButton).not.toHaveClass("ring-amber-400/70");
  });

  it("tree view renders herd leaders before expanded worker rows", () => {
    const leaderSessionId = "leader-first";
    const workerSessionId = "worker-first";
    const leaderSession = makeSession(leaderSessionId, { model: "leader-first-model" });
    const workerSession = makeSession(workerSessionId, { model: "worker-first-model" });
    mockState = createMockState({
      sessions: new Map([
        [leaderSessionId, leaderSession],
        [workerSessionId, workerSession],
      ]),
      sdkSessions: [
        makeSdkSession(leaderSessionId, {
          isOrchestrator: true,
          sessionNum: 41,
          createdAt: 100,
        }),
        makeSdkSession(workerSessionId, {
          herdedBy: leaderSessionId,
          sessionNum: 42,
          createdAt: 300,
        }),
      ],
      sessionNames: new Map([
        [leaderSessionId, "Leader First"],
        [workerSessionId, "Worker First"],
      ]),
      expandedHerdNodes: new Set([leaderSessionId]),
    });

    render(<Sidebar />);

    const leaderAfter = screen.getByText("Leader First").closest("button")!;
    const workerAfter = screen.getByText("Worker First").closest("button")!;
    expect(leaderAfter.compareDocumentPosition(workerAfter) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("tree view keeps workers in their leader's assigned group across projects", () => {
    const leaderSessionId = "leader-cross-project";
    const leaderPeerSessionId = "leader-peer";
    const workerSessionId = "worker-cross-project";
    const leaderSession = makeSession(leaderSessionId, { cwd: "/home/user/project-leader" });
    const leaderPeerSession = makeSession(leaderPeerSessionId, { cwd: "/home/user/project-leader" });
    const workerSession = makeSession(workerSessionId, { cwd: "/home/user/project-worker" });
    mockState = createMockState({
      sessions: new Map([
        [leaderSessionId, leaderSession],
        [leaderPeerSessionId, leaderPeerSession],
        [workerSessionId, workerSession],
      ]),
      sdkSessions: [
        makeSdkSession(leaderSessionId, {
          cwd: "/home/user/project-leader",
          isOrchestrator: true,
          sessionNum: 51,
          createdAt: 100,
        }),
        makeSdkSession(leaderPeerSessionId, {
          cwd: "/home/user/project-leader",
          sessionNum: 52,
          createdAt: 300,
        }),
        makeSdkSession(workerSessionId, {
          cwd: "/home/user/project-worker",
          herdedBy: leaderSessionId,
          sessionNum: 53,
          createdAt: 400,
        }),
      ],
      sessionNames: new Map([
        [leaderSessionId, "Cross Project Leader"],
        [leaderPeerSessionId, "Newer Leader-Project Peer"],
        [workerSessionId, "Cross Project Worker"],
      ]),
      treeGroups: [
        { id: "alpha", name: "Alpha" },
        { id: "beta", name: "Beta" },
      ],
      treeAssignments: new Map([
        [leaderSessionId, "alpha"],
        [leaderPeerSessionId, "alpha"],
        [workerSessionId, "beta"],
      ]),
      expandedHerdNodes: new Set([leaderSessionId]),
    });

    render(<Sidebar />);

    const workerButton = screen.getByText("Cross Project Worker").closest("button")!;
    const betaHeader = screen.getByText("Beta");
    expect(workerButton.compareDocumentPosition(betaHeader) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
