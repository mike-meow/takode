// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockNavigateTo = vi.fn();
const mockNavigateToSession = vi.fn();

vi.mock("../api.js", () => ({
  api: {
    relaunchSession: vi.fn().mockResolvedValue({ ok: true }),
  },
}));
vi.mock("../utils/navigation.js", () => ({
  navigateTo: (...args: unknown[]) => mockNavigateTo(...args),
  navigateToSession: (...args: unknown[]) => mockNavigateToSession(...args),
}));
vi.mock("./SessionInfoPopover.js", () => ({
  SessionInfoPopover: () => <div data-testid="session-info-popover" />,
}));

interface MockStoreState {
  currentSessionId: string | null;
  zoomLevel: number;
  cliConnected: Map<string, boolean>;
  cliDisconnectReason: Map<string, "idle_limit" | null>;
  sessionStatus: Map<string, "idle" | "running" | "compacting" | null>;
  sidebarOpen: boolean;
  setSidebarOpen: ReturnType<typeof vi.fn>;
  setSessionInfoOpenSessionId: ReturnType<typeof vi.fn>;
  taskPanelOpen: boolean;
  setTaskPanelOpen: ReturnType<typeof vi.fn>;
  activeTab: "chat" | "diff";
  setActiveTab: ReturnType<typeof vi.fn>;
  sessions: Map<string, { cwd?: string; permissionMode?: string; backend_type?: string }>;
  sdkSessions: {
    sessionId: string;
    createdAt: number;
    archived?: boolean;
    cwd?: string;
    name?: string;
    sessionNum?: number | null;
    permissionMode?: string;
    backendType?: string;
    cliConnected?: boolean;
    state?: "idle" | "running" | "compacting" | null;
  }[];
  changedFiles: Map<string, Set<string>>;
  pendingPermissions: Map<string, Map<string, unknown>>;
  sessionAttention: Map<string, "action" | "error" | "review" | null>;
  sessionNames: Map<string, string>;
  diffFileStats: Map<string, Map<string, { additions: number; deletions: number }>>;
  quests: { status: string }[];
  refreshQuests: ReturnType<typeof vi.fn>;
  questNamedSessions: Set<string>;
  shortcutSettings?: {
    enabled: boolean;
    preset: "standard" | "vscode-light" | "vim-light";
    overrides: Record<string, string | null>;
  };
  openSessionSearch: ReturnType<typeof vi.fn>;
  closeSessionSearch: ReturnType<typeof vi.fn>;
}

let storeState: MockStoreState;

function resetStore(overrides: Partial<MockStoreState> = {}) {
  storeState = {
    currentSessionId: "s1",
    zoomLevel: 1,
    cliConnected: new Map([["s1", true]]),
    cliDisconnectReason: new Map(),
    sessionStatus: new Map([["s1", "idle"]]),
    sidebarOpen: true,
    setSidebarOpen: vi.fn(),
    setSessionInfoOpenSessionId: vi.fn(),
    taskPanelOpen: false,
    setTaskPanelOpen: vi.fn(),
    activeTab: "chat",
    setActiveTab: vi.fn(),
    sessions: new Map([["s1", { cwd: "/repo" }]]),
    sdkSessions: [],
    changedFiles: new Map(),
    pendingPermissions: new Map(),
    sessionAttention: new Map(),
    sessionNames: new Map(),
    diffFileStats: new Map(),
    quests: [],
    refreshQuests: vi.fn().mockResolvedValue(undefined),
    questNamedSessions: new Set(),
    shortcutSettings: { enabled: false, preset: "standard", overrides: {} },
    openSessionSearch: vi.fn(),
    closeSessionSearch: vi.fn(),
    ...overrides,
  };
}

vi.mock("../store.js", () => ({
  useStore: (selector: (s: MockStoreState) => unknown) => selector(storeState),
  countUserPermissions: (perms: Map<string, unknown> | undefined): number => {
    if (!perms) return 0;
    let count = 0;
    for (const p of perms.values()) {
      const perm = p as { evaluating?: boolean; autoApproved?: string };
      if (!perm?.evaluating && !perm?.autoApproved) count++;
    }
    return count;
  },
  getSessionSearchState: () => ({
    query: "",
    isOpen: false,
    mode: "strict",
    category: "all",
    matches: [],
    currentMatchIndex: -1,
  }),
}));

import { TopBar, getTopBarStatusSummary, splitAttentionSessionIdsKey } from "./TopBar.js";

beforeEach(() => {
  vi.clearAllMocks();
  window.innerWidth = 1280;
  resetStore();
});

describe("TopBar", () => {
  it("derives attention summary counts from visible session state", () => {
    resetStore({
      sdkSessions: [
        { sessionId: "s-archived", createdAt: 99, archived: true, cliConnected: true, state: "idle" },
        { sessionId: "s-running", createdAt: 40, cliConnected: true, state: "running" },
        { sessionId: "s-waiting", createdAt: 30, cliConnected: true, state: "idle" },
        { sessionId: "s-unread", createdAt: 20, cliConnected: true, state: "idle" },
      ],
      sessionStatus: new Map([
        ["s-running", "running"],
        ["s-waiting", "idle"],
        ["s-unread", "idle"],
      ]),
      cliConnected: new Map([
        ["s-running", true],
        ["s-waiting", true],
        ["s-unread", true],
      ]),
      pendingPermissions: new Map([["s-waiting", new Map([["perm-1", {}]])]]),
      sessionAttention: new Map([["s-unread", "review"]]),
    });

    const summary = getTopBarStatusSummary(storeState as unknown as Parameters<typeof getTopBarStatusSummary>[0]);

    expect(summary.running).toBe(1);
    expect(summary.waiting).toBe(1);
    expect(summary.unread).toBe(1);
    expect(splitAttentionSessionIdsKey(summary.attentionSessionIdsKey)).toEqual(["s-waiting", "s-unread"]);
  });

  it("stops quest badge polling while the tab is hidden", async () => {
    vi.useFakeTimers();
    let visibilityState: DocumentVisibilityState = "hidden";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });

    try {
      render(<TopBar />);
      expect(storeState.refreshQuests).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(20_000);
      expect(storeState.refreshQuests).toHaveBeenCalledTimes(1);

      visibilityState = "visible";
      fireEvent(document, new Event("visibilitychange"));
      expect(storeState.refreshQuests).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(15_000);
      expect(storeState.refreshQuests).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows session number next to the session name in the title area", () => {
    resetStore({
      sessions: new Map([["s1", { cwd: "/repo", permissionMode: "acceptEdits", backend_type: "claude" }]]),
      sessionNames: new Map([["s1", "Main Session"]]),
      sdkSessions: [{ sessionId: "s1", createdAt: 1, sessionNum: 111, name: "Main Session" }],
    });

    render(<TopBar />);
    expect(screen.getByText("#111")).toBeInTheDocument();
    expect(screen.getByText("Main Session")).toBeInTheDocument();
  });

  it("does not show a duplicate plan/agent mode label in title bar", () => {
    resetStore({
      sessions: new Map([["s1", { cwd: "/repo", permissionMode: "plan", backend_type: "codex" }]]),
      sdkSessions: [
        {
          sessionId: "s1",
          createdAt: 1,
          sessionNum: 111,
          name: "Main Session",
          permissionMode: "plan",
          backendType: "codex",
        },
      ],
    });

    render(<TopBar />);
    expect(screen.queryByTitle("Current mode: Plan")).not.toBeInTheDocument();
  });

  it("shows diff badge count only for files within cwd", () => {
    resetStore({
      changedFiles: new Map([
        ["s1", new Set(["/repo/src/a.ts", "/repo/src/b.ts", "/Users/stan/.claude/plans/plan.md"])],
      ]),
    });

    render(<TopBar />);
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.queryByText("3")).not.toBeInTheDocument();
  });

  it("hides diff badge when all changed files are out of scope", () => {
    resetStore({
      changedFiles: new Map([["s1", new Set(["/Users/stan/.claude/plans/plan.md"])]]),
    });

    render(<TopBar />);
    expect(screen.queryByText("1")).not.toBeInTheDocument();
  });

  it("publishes opened session info panel id for sidebar-linked highlights", async () => {
    render(<TopBar />);

    fireEvent.click(screen.getByTitle("Session info"));
    await waitFor(() => {
      expect(storeState.setSessionInfoOpenSessionId).toHaveBeenLastCalledWith("s1");
    });

    fireEvent.click(screen.getByTitle("Session info"));
    await waitFor(() => {
      expect(storeState.setSessionInfoOpenSessionId).toHaveBeenLastCalledWith(null);
    });
  });

  it("shows the enabled search shortcut in the hover title", () => {
    resetStore({
      shortcutSettings: { enabled: true, preset: "standard", overrides: {} },
    });

    render(<TopBar />);
    expect(screen.getByTitle("Search messages (Ctrl+F)")).toBeInTheDocument();
  });

  it("cycles to the next attention session on mobile without opening the sidebar", () => {
    window.innerWidth = 390;
    resetStore({
      currentSessionId: "s1",
      sdkSessions: [
        { sessionId: "s1", createdAt: 20, name: "First" },
        { sessionId: "s2", createdAt: 10, name: "Second" },
      ],
      sessionAttention: new Map([
        ["s1", "review"],
        ["s2", "review"],
      ]),
      sessionStatus: new Map([
        ["s1", "idle"],
        ["s2", "idle"],
      ]),
      cliConnected: new Map([
        ["s1", true],
        ["s2", true],
      ]),
    });

    render(<TopBar />);

    fireEvent.click(screen.getByTitle("Cycle through sessions needing attention"));

    expect(mockNavigateToSession).toHaveBeenCalledWith("s2");
    expect(storeState.setSidebarOpen).not.toHaveBeenCalled();
  });

  it("does nothing on mobile when there is no next attention session", () => {
    window.innerWidth = 390;
    resetStore({
      currentSessionId: "s2",
      sdkSessions: [
        { sessionId: "s1", createdAt: 20, name: "First" },
        { sessionId: "s2", createdAt: 10, name: "Second" },
      ],
      sessionAttention: new Map([
        ["s1", "review"],
        ["s2", "review"],
      ]),
      sessionStatus: new Map([
        ["s1", "idle"],
        ["s2", "idle"],
      ]),
      cliConnected: new Map([
        ["s1", true],
        ["s2", true],
      ]),
    });

    render(<TopBar />);

    fireEvent.click(screen.getByTitle("Cycle through sessions needing attention"));

    expect(mockNavigateToSession).not.toHaveBeenCalled();
    expect(storeState.setSidebarOpen).not.toHaveBeenCalled();
  });
});
