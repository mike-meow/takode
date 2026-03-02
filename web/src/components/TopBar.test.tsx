// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

vi.mock("../api.js", () => ({
  api: {
    relaunchSession: vi.fn().mockResolvedValue({ ok: true }),
  },
}));
vi.mock("./SessionInfoPopover.js", () => ({
  SessionInfoPopover: () => <div data-testid="session-info-popover" />,
}));

interface MockStoreState {
  currentSessionId: string | null;
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
  sdkSessions: { sessionId: string; cwd?: string; name?: string; sessionNum?: number | null; permissionMode?: string; backendType?: string }[];
  changedFiles: Map<string, Set<string>>;
  pendingPermissions: Map<string, Map<string, unknown>>;
  sessionAttention: Map<string, "action" | "error" | "review" | null>;
  sessionNames: Map<string, string>;
  diffFileStats: Map<string, Map<string, { additions: number; deletions: number }>>;
  quests: { status: string }[];
  refreshQuests: ReturnType<typeof vi.fn>;
  questNamedSessions: Set<string>;
}

let storeState: MockStoreState;

function resetStore(overrides: Partial<MockStoreState> = {}) {
  storeState = {
    currentSessionId: "s1",
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
}));

import { TopBar } from "./TopBar.js";

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
});

describe("TopBar", () => {
  it("shows session number next to the session name in the title area", () => {
    resetStore({
      sessions: new Map([["s1", { cwd: "/repo", permissionMode: "acceptEdits", backend_type: "claude" }]]),
      sessionNames: new Map([["s1", "Main Session"]]),
      sdkSessions: [{ sessionId: "s1", sessionNum: 111, name: "Main Session" }],
    });

    render(<TopBar />);
    expect(screen.getByText("#111")).toBeInTheDocument();
    expect(screen.getByText("Main Session")).toBeInTheDocument();
  });

  it("shows plan mode indicator in title bar", () => {
    resetStore({
      sessions: new Map([["s1", { cwd: "/repo", permissionMode: "plan", backend_type: "codex" }]]),
      sdkSessions: [{ sessionId: "s1", sessionNum: 111, name: "Main Session", permissionMode: "plan", backendType: "codex" }],
    });

    render(<TopBar />);
    expect(screen.getByTitle("Current mode: Plan")).toBeInTheDocument();
  });

  it("shows diff badge count only for files within cwd", () => {
    resetStore({
      changedFiles: new Map([
        [
          "s1",
          new Set(["/repo/src/a.ts", "/repo/src/b.ts", "/Users/stan/.claude/plans/plan.md"]),
        ],
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
});
