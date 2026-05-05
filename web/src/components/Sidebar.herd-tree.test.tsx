// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { SessionState, SdkSessionInfo } from "../types.js";

const mockConnectSession = vi.fn();
const mockConnectAllSessions = vi.fn();
const mockDisconnectSession = vi.fn();
const mockScrollIntoView = vi.fn();

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
  createTreeGroup: vi.fn().mockResolvedValue({ ok: true, group: { id: "group-2", name: "Session Space 2" } }),
  assignSessionToTreeGroup: vi.fn().mockResolvedValue({ ok: true }),
  assignSessionsToTreeGroup: vi.fn().mockResolvedValue({ ok: true }),
  updateTreeGroups: vi.fn().mockResolvedValue({ ok: true }),
  updateTreeNodeOrder: vi.fn().mockResolvedValue({ ok: true }),
  herdWorkerToLeader: vi
    .fn()
    .mockResolvedValue({ herded: ["worker-1"], notFound: [], conflicts: [], reassigned: [], leaders: [] }),
  refreshSessionGitStatus: vi.fn().mockResolvedValue({ ok: true }),
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
    createTreeGroup: (...args: unknown[]) => mockApi.createTreeGroup(...args),
    assignSessionToTreeGroup: (...args: unknown[]) => mockApi.assignSessionToTreeGroup(...args),
    assignSessionsToTreeGroup: (...args: unknown[]) => mockApi.assignSessionsToTreeGroup(...args),
    updateTreeGroups: (...args: unknown[]) => mockApi.updateTreeGroups(...args),
    updateTreeNodeOrder: (...args: unknown[]) => mockApi.updateTreeNodeOrder(...args),
    herdWorkerToLeader: (...args: unknown[]) => mockApi.herdWorkerToLeader(...args),
    refreshSessionGitStatus: (...args: unknown[]) => mockApi.refreshSessionGitStatus(...args),
    getSettings: (...args: unknown[]) => mockApi.getSettings(...args),
    updateSettings: (...args: unknown[]) => mockApi.updateSettings(...args),
    getTreeGroups: (...args: unknown[]) => mockApi.getTreeGroups(...args),
  },
}));

vi.mock("../utils/copy-utils.js", () => ({
  writeClipboardText: vi.fn().mockResolvedValue(undefined),
}));

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
  sessionNotifications: Map<string, Array<unknown>>;
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
  searchPreviewSessionId: string | null;
  sessionInfoOpenSessionId: string | null;
  reorderMode: boolean;
  sessionSortMode: "created" | "activity";
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
  setSearchPreviewSessionId: ReturnType<typeof vi.fn>;
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
  focusComposer: ReturnType<typeof vi.fn>;
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
    sessionNotifications: new Map(),
    recentlyRenamed: new Set(),
    questNamedSessions: new Set(),
    pendingPermissions: new Map(),
    sessionAttention: new Map(),
    diffFileStats: new Map(),
    shortcutSettings: { enabled: false, preset: "standard", overrides: {} },
    searchPreviewSessionId: null,
    sessionInfoOpenSessionId: null,
    reorderMode: false,
    sessionSortMode: "created",
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
    setSearchPreviewSessionId: vi.fn(),
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
    focusComposer: vi.fn(),
    ...overrides,
  };
}

vi.mock("../store.js", () => {
  const useStoreFn = (selector: (state: MockStoreState) => unknown) => selector(mockState);
  useStoreFn.getState = () => mockState;
  const countUserPermissions = (perms: Map<string, unknown> | undefined): number => perms?.size ?? 0;
  return { useStore: useStoreFn, countUserPermissions };
});

import { Sidebar } from "./Sidebar.js";
import { resetSessionGitStatusAutoRefreshForTest } from "../utils/session-git-status-auto-refresh.js";

beforeEach(() => {
  vi.clearAllMocks();
  resetSessionGitStatusAutoRefreshForTest();
  mockApi.refreshSessionGitStatus.mockResolvedValue({ ok: true });
  vi.stubGlobal("alert", vi.fn());
  Element.prototype.scrollIntoView = mockScrollIntoView;
  mockState = createMockState();
  window.location.hash = "";
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

describe("Sidebar herd tree behavior", { timeout: 10000 }, () => {
  it("hovering a herded worker highlights its leader and shows leader info in hover card", async () => {
    const leaderSessionId = "leader-1";
    const workerSessionId = "worker-1";
    mockState = createMockState({
      sessions: new Map([
        [leaderSessionId, makeSession(leaderSessionId, { model: "leader-model" })],
        [workerSessionId, makeSession(workerSessionId, { model: "worker-model" })],
      ]),
      sdkSessions: [
        makeSdkSession(leaderSessionId, { isOrchestrator: true, sessionNum: 7, createdAt: 1700000000000 }),
        makeSdkSession(workerSessionId, { herdedBy: leaderSessionId, sessionNum: 11, createdAt: 1700000001000 }),
      ],
      sessionNames: new Map([
        [leaderSessionId, "Leader Session"],
        [workerSessionId, "Worker Session"],
      ]),
      expandedHerdNodes: new Set([leaderSessionId]),
    });

    render(<Sidebar />);
    fireEvent.mouseEnter(screen.getByText("Worker Session").closest("button")!);

    await waitFor(() => {
      expect(screen.getByText("Herded by")).toBeInTheDocument();
      const section = screen.getByTestId("session-hover-herded-by");
      expect(within(section).getByRole("button", { name: "#7" })).toBeInTheDocument();
    });
  });

  it("keeps workers grouped under the correct leader when multiple herds are expanded", () => {
    mockState = createMockState({
      sessions: new Map([
        ["leader-alpha", makeSession("leader-alpha", { model: "leader-alpha-model" })],
        ["worker-alpha", makeSession("worker-alpha", { model: "worker-alpha-model" })],
        ["leader-beta", makeSession("leader-beta", { model: "leader-beta-model" })],
        ["worker-beta", makeSession("worker-beta", { model: "worker-beta-model" })],
      ]),
      sdkSessions: [
        makeSdkSession("leader-alpha", { isOrchestrator: true, sessionNum: 7, createdAt: 1700000001000 }),
        makeSdkSession("worker-alpha", { herdedBy: "leader-alpha", sessionNum: 8, createdAt: 1700000002000 }),
        makeSdkSession("leader-beta", { isOrchestrator: true, sessionNum: 9, createdAt: 1700000003000 }),
        makeSdkSession("worker-beta", { herdedBy: "leader-beta", sessionNum: 10, createdAt: 1700000004000 }),
      ],
      sessionNames: new Map([
        ["leader-alpha", "Leader Alpha"],
        ["worker-alpha", "Worker Alpha"],
        ["leader-beta", "Leader Beta"],
        ["worker-beta", "Worker Beta"],
      ]),
      expandedHerdNodes: new Set(["leader-alpha", "leader-beta"]),
    });

    render(<Sidebar />);

    const leaderAlphaButton = screen.getByText("Leader Alpha").closest("button")!;
    const workerAlphaButton = screen.getByText("Worker Alpha").closest("button")!;
    const leaderBetaButton = screen.getByText("Leader Beta").closest("button")!;
    const workerBetaButton = screen.getByText("Worker Beta").closest("button")!;

    expect(
      leaderAlphaButton.compareDocumentPosition(workerAlphaButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(leaderBetaButton.compareDocumentPosition(workerBetaButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("does not add redundant herd highlight rings when leader info panel is open in tree view", () => {
    mockState = createMockState({
      sessions: new Map([
        ["leader-2", makeSession("leader-2", { model: "leader-open-model" })],
        ["worker-2", makeSession("worker-2", { model: "worker-open-model" })],
      ]),
      sdkSessions: [
        makeSdkSession("leader-2", { isOrchestrator: true, sessionNum: 21, createdAt: 1700000002000 }),
        makeSdkSession("worker-2", { herdedBy: "leader-2", sessionNum: 22, createdAt: 1700000003000 }),
      ],
      sessionNames: new Map([
        ["leader-2", "Leader Open"],
        ["worker-2", "Worker Open"],
      ]),
      sessionInfoOpenSessionId: "leader-2",
      expandedHerdNodes: new Set(["leader-2"]),
    });

    render(<Sidebar />);
    expect(screen.getByText("Worker Open").closest("button")).not.toHaveClass("ring-amber-400/45");
  });

  it("does not add redundant herd highlight rings when worker info panel is open in tree view", () => {
    mockState = createMockState({
      sessions: new Map([
        ["leader-3", makeSession("leader-3", { model: "leader-worker-open-model" })],
        ["worker-3", makeSession("worker-3", { model: "worker-worker-open-model" })],
      ]),
      sdkSessions: [
        makeSdkSession("leader-3", { isOrchestrator: true, sessionNum: 31, createdAt: 1700000004000 }),
        makeSdkSession("worker-3", { herdedBy: "leader-3", sessionNum: 32, createdAt: 1700000005000 }),
      ],
      sessionNames: new Map([
        ["leader-3", "Leader Worker Open"],
        ["worker-3", "Worker Worker Open"],
      ]),
      sessionInfoOpenSessionId: "worker-3",
      expandedHerdNodes: new Set(["leader-3"]),
    });

    render(<Sidebar />);
    expect(screen.getByText("Leader Worker Open").closest("button")).not.toHaveClass("ring-amber-400/70");
  });

  it("tree view renders herd leaders before expanded worker rows", () => {
    mockState = createMockState({
      sessions: new Map([
        ["leader-first", makeSession("leader-first", { model: "leader-first-model" })],
        ["worker-first", makeSession("worker-first", { model: "worker-first-model" })],
      ]),
      sdkSessions: [
        makeSdkSession("leader-first", { isOrchestrator: true, sessionNum: 41, createdAt: 100 }),
        makeSdkSession("worker-first", { herdedBy: "leader-first", sessionNum: 42, createdAt: 300 }),
      ],
      sessionNames: new Map([
        ["leader-first", "Leader First"],
        ["worker-first", "Worker First"],
      ]),
      expandedHerdNodes: new Set(["leader-first"]),
    });

    render(<Sidebar />);

    const leaderAfter = screen.getByText("Leader First").closest("button")!;
    const workerAfter = screen.getByText("Worker First").closest("button")!;
    expect(leaderAfter.compareDocumentPosition(workerAfter) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("refreshes stale expanded worker git rows in the background", async () => {
    const staleAt = Date.now() - 10 * 60_000;
    mockState = createMockState({
      sessions: new Map([
        ["leader-refresh", makeSession("leader-refresh", { model: "leader-refresh-model", is_worktree: true })],
        [
          "worker-refresh",
          makeSession("worker-refresh", {
            model: "worker-refresh-model",
            is_worktree: true,
            git_branch: "worker-refresh",
            git_ahead: 1,
            total_lines_added: 12,
            git_status_refreshed_at: staleAt,
          }),
        ],
      ]),
      sdkSessions: [
        makeSdkSession("leader-refresh", {
          isOrchestrator: true,
          isWorktree: true,
          sessionNum: 61,
          createdAt: 100,
        }),
        makeSdkSession("worker-refresh", {
          herdedBy: "leader-refresh",
          isWorktree: true,
          sessionNum: 62,
          createdAt: 200,
        }),
      ],
      sessionNames: new Map([
        ["leader-refresh", "Leader Refresh"],
        ["worker-refresh", "Worker Refresh"],
      ]),
      expandedHerdNodes: new Set(["leader-refresh"]),
    });

    render(<Sidebar />);

    await waitFor(() => {
      expect(mockApi.refreshSessionGitStatus).toHaveBeenCalledWith("worker-refresh", { force: false });
    });
  });

  it("tree view keeps workers in their leader's assigned group across projects", () => {
    mockState = createMockState({
      sessions: new Map([
        ["leader-cross-project", makeSession("leader-cross-project", { cwd: "/home/user/project-leader" })],
        ["leader-peer", makeSession("leader-peer", { cwd: "/home/user/project-leader" })],
        ["worker-cross-project", makeSession("worker-cross-project", { cwd: "/home/user/project-worker" })],
      ]),
      sdkSessions: [
        makeSdkSession("leader-cross-project", {
          cwd: "/home/user/project-leader",
          isOrchestrator: true,
          sessionNum: 51,
          createdAt: 100,
        }),
        makeSdkSession("leader-peer", { cwd: "/home/user/project-leader", sessionNum: 52, createdAt: 300 }),
        makeSdkSession("worker-cross-project", {
          cwd: "/home/user/project-worker",
          herdedBy: "leader-cross-project",
          sessionNum: 53,
          createdAt: 400,
        }),
      ],
      sessionNames: new Map([
        ["leader-cross-project", "Cross Project Leader"],
        ["leader-peer", "Newer Leader-Project Peer"],
        ["worker-cross-project", "Cross Project Worker"],
      ]),
      treeGroups: [
        { id: "alpha", name: "Alpha" },
        { id: "beta", name: "Beta" },
      ],
      treeAssignments: new Map([
        ["leader-cross-project", "alpha"],
        ["leader-peer", "alpha"],
        ["worker-cross-project", "beta"],
      ]),
      expandedHerdNodes: new Set(["leader-cross-project"]),
    });

    render(<Sidebar />);

    const workerButton = screen.getByText("Cross Project Worker").closest("button")!;
    const betaHeader = screen.getByText("Beta");
    expect(workerButton.compareDocumentPosition(betaHeader) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
