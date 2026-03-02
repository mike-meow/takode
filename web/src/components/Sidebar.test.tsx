// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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

const mockApi = {
  listSessions: vi.fn().mockResolvedValue([]),
  searchSessions: vi.fn().mockResolvedValue({ query: "", tookMs: 0, totalMatches: 0, results: [] }),
  deleteSession: vi.fn().mockResolvedValue({}),
  archiveSession: vi.fn().mockResolvedValue({}),
  unarchiveSession: vi.fn().mockResolvedValue({}),
  getSettings: vi.fn().mockResolvedValue({ serverName: "" }),
};

vi.mock("../api.js", () => ({
  api: {
    listSessions: (...args: unknown[]) => mockApi.listSessions(...args),
    searchSessions: (...args: unknown[]) => mockApi.searchSessions(...args),
    deleteSession: (...args: unknown[]) => mockApi.deleteSession(...args),
    archiveSession: (...args: unknown[]) => mockApi.archiveSession(...args),
    unarchiveSession: (...args: unknown[]) => mockApi.unarchiveSession(...args),
    getSettings: (...args: unknown[]) => mockApi.getSettings(...args),
  },
}));

const mockWriteClipboardText = vi.fn().mockResolvedValue(undefined);
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
  collapsedProjects: Set<string>;
  sessionAttention: Map<string, "action" | "error" | "review" | null>;
  diffFileStats: Map<string, Map<string, { additions: number; deletions: number }>>;
  sessionOrder: Map<string, string[]>;
  reorderMode: boolean;
  setReorderMode: ReturnType<typeof vi.fn>;
  pendingSessions: Map<string, unknown>;
  serverName: string;
  setServerName: ReturnType<typeof vi.fn>;
  setCurrentSession: ReturnType<typeof vi.fn>;
  toggleProjectCollapse: ReturnType<typeof vi.fn>;
  removeSession: ReturnType<typeof vi.fn>;
  newSession: ReturnType<typeof vi.fn>;
  setSidebarOpen: ReturnType<typeof vi.fn>;
  setSessionName: ReturnType<typeof vi.fn>;
  setSessionPreview: ReturnType<typeof vi.fn>;
  markRecentlyRenamed: ReturnType<typeof vi.fn>;
  clearRecentlyRenamed: ReturnType<typeof vi.fn>;
  setSdkSessions: ReturnType<typeof vi.fn>;
  closeTerminal: ReturnType<typeof vi.fn>;
  setShowNewSessionModal: ReturnType<typeof vi.fn>;
  markSessionViewed: ReturnType<typeof vi.fn>;
  markAllSessionsViewed: ReturnType<typeof vi.fn>;
  markSessionUnread: ReturnType<typeof vi.fn>;
  clearSessionAttention: ReturnType<typeof vi.fn>;
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
    collapsedProjects: new Set(),
    sessionAttention: new Map(),
    diffFileStats: new Map(),
    sessionOrder: new Map(),
    reorderMode: false,
    setReorderMode: vi.fn(),
    pendingSessions: new Map(),
    serverName: "",
    setServerName: vi.fn(),
    setCurrentSession: vi.fn(),
    toggleProjectCollapse: vi.fn(),
    removeSession: vi.fn(),
    newSession: vi.fn(),
    setSidebarOpen: vi.fn(),
    setSessionName: vi.fn(),
    setSessionPreview: vi.fn(),
    markRecentlyRenamed: vi.fn(),
    clearRecentlyRenamed: vi.fn(),
    setSdkSessions: vi.fn(),
    closeTerminal: vi.fn(),
    setShowNewSessionModal: vi.fn(),
    markSessionViewed: vi.fn(),
    markAllSessionsViewed: vi.fn(),
    markSessionUnread: vi.fn(),
    clearSessionAttention: vi.fn(),
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
  mockState = createMockState();
  window.location.hash = "";
});

describe("Sidebar", () => {
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
      sessions: new Map([["s1", session1], ["s2", session2]]),
      sdkSessions: [sdk1, sdk2],
      sessionNames: new Map([["s1", "Alpha"], ["s2", "Archived beta"]]),
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

    expect(screen.getByText("message: find beta in archived session")).toBeInTheDocument();
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

  it("session items show project name in group header (not in session row)", () => {
    const session = makeSession("s1", { cwd: "/home/user/projects/myapp" });
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    // "myapp" appears in the project group header
    expect(screen.getByText("myapp")).toBeInTheDocument();
  });

  it("session items show git branch when available", () => {
    const session = makeSession("s1", { git_branch: "feature/awesome" });
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    expect(screen.getByText("feature/awesome")).toBeInTheDocument();
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
    const sessionButton = screen.getByText("main").closest("button")!;
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
    const sessionButton = screen.getByText("jiayi-wt-9954").closest("button")!;
    expect(sessionButton.textContent).toContain("6↓");
    expect(sessionButton.textContent).toContain("+167");
    expect(sessionButton.textContent).toContain("-858");
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

    // handleNewSession now opens the modal instead of navigating home + calling newSession
    expect(mockState.setShowNewSessionModal).toHaveBeenCalledWith(true);
  });

  it("double-clicking a session enters edit mode", () => {
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
    const input = screen.getByDisplayValue("claude-sonnet-4-5-20250929");
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
    expect(archiveButton).toHaveClass("right-2");
    expect(archiveButton).toHaveClass("sm:left-2");
    expect(archiveButton).toHaveClass("sm:right-auto");
    expect(sessionButton).toHaveClass("sm:pl-8");
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
    const mobilePermissionBadge = screen.getAllByText("1").find((node) =>
      node.classList.contains("bg-cc-warning") && node.classList.contains("px-1"),
    )!;
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
      sessions: new Map([["s1", session1], ["s2", session2]]),
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
      sessions: new Map([["s1", session1], ["s2", session2]]),
      sdkSessions: [sdk1, sdk2],
      reorderMode: true,
    });

    render(<Sidebar />);
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
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
    const fiberKey = Object.keys(animatedSpan!).find((k) =>
      k.startsWith("__reactFiber$"),
    );
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
      sessions: new Map([["s1", session1], ["s2", session2]]),
      sdkSessions: [sdk1, sdk2],
      sessionNames: new Map([["s1", "Renamed Session"], ["s2", "Other Session"]]),
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

  it("session shows git branch from sdkInfo when bridgeState is unavailable", () => {
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
    expect(screen.getByText("feature/from-rest")).toBeInTheDocument();
    const sessionButton = screen.getByText("feature/from-rest").closest("button")!;
    expect(sessionButton.textContent).toContain("5");
    expect(sessionButton.textContent).toContain("2");
    expect(sessionButton.textContent).toContain("+100");
    expect(sessionButton.textContent).toContain("-20");
  });

  it("session prefers bridgeState git data over sdkInfo", () => {
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
    // Bridge data should win over REST API data
    expect(screen.getByText("from-bridge")).toBeInTheDocument();
    expect(screen.queryByText("from-rest")).not.toBeInTheDocument();
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
      sessions: new Map([["s1", session1], ["s2", session2]]),
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
      sessions: new Map([["s1", session1], ["s2", session2], ["s3", session3]]),
      sdkSessions: [sdk1, sdk2, sdk3],
    });

    render(<Sidebar />);
    // Project group headers should be visible (also appears as dirName in session items)
    expect(screen.getAllByText("project-a").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("project-b").length).toBeGreaterThanOrEqual(1);
  });

  it("project group header shows running count as colored dot", () => {
    const session1 = makeSession("s1", { cwd: "/home/user/myapp" });
    const session2 = makeSession("s2", { cwd: "/home/user/myapp" });
    const sdk1 = makeSdkSession("s1", { cwd: "/home/user/myapp" });
    const sdk2 = makeSdkSession("s2", { cwd: "/home/user/myapp" });
    mockState = createMockState({
      sessions: new Map([["s1", session1], ["s2", session2]]),
      sdkSessions: [sdk1, sdk2],
      sessionStatus: new Map([["s1", "running"], ["s2", "running"]]),
      cliConnected: new Map([["s1", true], ["s2", true]]),
    });

    const { container } = render(<Sidebar />);
    // Status is now shown as colored number + dot (e.g. "2●") not "2 running"
    const greenDots = container.querySelectorAll(".bg-cc-success.rounded-full");
    expect(greenDots.length).toBeGreaterThanOrEqual(1);
  });

  it("collapsing a project group hides its sessions", () => {
    const session = makeSession("s1", { cwd: "/home/user/myapp", model: "hidden-model" });
    const sdk = makeSdkSession("s1", { cwd: "/home/user/myapp" });
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
      collapsedProjects: new Set(["/home/user/myapp"]),
    });

    render(<Sidebar />);
    // Group header should still be visible
    expect(screen.getByText("myapp")).toBeInTheDocument();
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
});
