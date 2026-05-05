// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { SessionNotification, SessionState, SdkSessionInfo } from "../types.js";

const mockConnectSession = vi.fn();
const mockConnectAllSessions = vi.fn();
const mockDisconnectSession = vi.fn();
const scrollTargetSessionIds: string[] = [];
const mockScrollIntoView = vi.fn(function (this: Element) {
  scrollTargetSessionIds.push((this as HTMLElement).dataset.sessionId ?? "");
});

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
  createTreeGroup: vi.fn().mockResolvedValue({ ok: true, group: { id: "group-2", name: "Group 2" } }),
  assignSessionToTreeGroup: vi.fn().mockResolvedValue({ ok: true }),
  assignSessionsToTreeGroup: vi.fn().mockResolvedValue({ ok: true }),
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
    createTreeGroup: (...args: unknown[]) => mockApi.createTreeGroup(...args),
    assignSessionToTreeGroup: (...args: unknown[]) => mockApi.assignSessionToTreeGroup(...args),
    assignSessionsToTreeGroup: (...args: unknown[]) => mockApi.assignSessionsToTreeGroup(...args),
    herdWorkerToLeader: (...args: unknown[]) => mockApi.herdWorkerToLeader(...args),
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
  sessionNotifications: Map<string, SessionNotification[]>;
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
  setReorderMode: ReturnType<typeof vi.fn>;
  sessionSortMode: "created" | "activity";
  setSessionSortMode: ReturnType<typeof vi.fn>;
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
    setReorderMode: vi.fn(),
    sessionSortMode: "created",
    setSessionSortMode: vi.fn(),
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

import { Sidebar } from "./Sidebar.js";

beforeEach(() => {
  vi.clearAllMocks();
  scrollTargetSessionIds.length = 0;
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

describe("Sidebar session rows", { timeout: 10000 }, () => {
  it("active session has highlighted styling", () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
      currentSessionId: "s1",
    });

    render(<Sidebar />);

    expect(screen.getByText("claude-sonnet-4-5-20250929").closest("button")).toHaveClass("bg-cc-active");
  });

  it("auto-scrolls the sidebar to keep the active session row visible", () => {
    const session1 = makeSession("s1", { model: "Session One" });
    const session2 = makeSession("s2", { model: "Session Two" });
    const sdk1 = makeSdkSession("s1", { model: "Session One", createdAt: 2 });
    const sdk2 = makeSdkSession("s2", { model: "Session Two", createdAt: 1 });
    mockState = createMockState({
      sessions: new Map([
        ["s1", session1],
        ["s2", session2],
      ]),
      sdkSessions: [sdk1, sdk2],
      currentSessionId: "s2",
      treeGroups: [{ id: "default", name: "Default" }],
      treeNodeOrder: new Map([["default", ["s1", "s2"]]]),
    });

    render(<Sidebar />);

    expect(screen.getByText("Session Two").closest("button")).toHaveAttribute("data-active-session", "true");
    expect(mockScrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(scrollTargetSessionIds).toContain("s2");
  });

  it("clicking a session navigates to the session hash", () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
      currentSessionId: null,
    });

    render(<Sidebar />);
    fireEvent.click(screen.getByText("claude-sonnet-4-5-20250929").closest("button")!);

    expect(window.location.hash).toBe("#/session/s1");
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
    fireEvent.click(screen.getByLabelText("Create session in Default Session Space"));

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
    fireEvent.click(screen.getByLabelText("Create session in Takode Session Space"));

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
    fireEvent.doubleClick(screen.getByText("claude-sonnet-4-5-20250929").closest("button")!);

    const input = await screen.findByDisplayValue("claude-sonnet-4-5-20250929");
    expect(input).toBeInTheDocument();
    expect(input.tagName).toBe("INPUT");
  });

  it("does not steal focus back to the composer after double-click rename starts", async () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    const animationFrameCallbacks: FrameRequestCallback[] = [];
    const requestAnimationFrameMock = vi.fn((callback: FrameRequestCallback) => {
      animationFrameCallbacks.push(callback);
      return animationFrameCallbacks.length;
    });
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrameMock);
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    try {
      render(<Sidebar />);
      const sessionButton = screen.getByText("claude-sonnet-4-5-20250929").closest("button")!;
      fireEvent.click(sessionButton);
      fireEvent.doubleClick(sessionButton);

      await screen.findByDisplayValue("claude-sonnet-4-5-20250929");
      expect(animationFrameCallbacks.length).toBeGreaterThan(0);
      mockState.focusComposer.mockClear();
      while (animationFrameCallbacks.length > 0) {
        animationFrameCallbacks.shift()?.(performance.now());
      }

      expect(mockState.focusComposer).not.toHaveBeenCalled();
    } finally {
      vi.stubGlobal("requestAnimationFrame", originalRequestAnimationFrame);
    }
  });
});
