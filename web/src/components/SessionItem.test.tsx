// @vitest-environment jsdom
import { render, fireEvent, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { useState, type ComponentProps } from "react";
import type { SidebarSessionItem as SessionItemType } from "../utils/sidebar-session-item.js";
import type { HerdGroupBadgeTheme } from "../utils/herd-group-theme.js";

const mockStoreState = {
  questNamedSessions: new Set<string>(),
  sessions: new Map<string, { claimedQuestStatus?: string; claimedQuestVerificationInboxUnread?: boolean }>(),
  sessionTaskPreview: new Map<string, { text: string; updatedAt: number }>(),
  sessionPreviewUpdatedAt: new Map<string, number>(),
  sessionAttention: new Map<string, "action" | "error" | "review" | null>(),
  sessionNotifications: new Map<string, Array<any>>(),
  sessionTimers: new Map<string, Array<{ id: string }>>(),
  sdkSessions: [] as Array<any>,
  currentSessionId: "s1",
};

vi.mock("../store.js", () => ({
  useStore: (selector: (state: typeof mockStoreState) => unknown) => selector(mockStoreState),
}));

const mockNavigateToSession = vi.fn();
vi.mock("../utils/routing.js", () => ({
  navigateToSession: (...args: unknown[]) => mockNavigateToSession(...args),
}));

const mockRefreshSessionGitStatus = vi.fn().mockResolvedValue({
  ok: true,
  gitBranch: "main",
  gitDefaultBranch: "main",
  diffBaseBranch: "main",
  gitAhead: 0,
  gitBehind: 0,
  totalLinesAdded: 0,
  totalLinesRemoved: 0,
  gitStatusRefreshedAt: 123,
  gitStatusRefreshError: null,
});

vi.mock("../api.js", () => ({
  api: {
    refreshSessionGitStatus: (...args: unknown[]) => mockRefreshSessionGitStatus(...args),
  },
}));

import { SessionItem } from "./SessionItem.js";

function makeSession(overrides: Partial<SessionItemType> = {}): SessionItemType {
  return {
    id: "s1",
    model: "gpt-5-codex",
    cwd: "/repo",
    gitBranch: "main",
    isContainerized: false,
    gitAhead: 0,
    gitBehind: 0,
    linesAdded: 0,
    linesRemoved: 0,
    isConnected: true,
    status: "idle",
    sdkState: "connected",
    createdAt: Date.now(),
    archived: false,
    backendType: "codex",
    repoRoot: "/repo",
    permCount: 0,
    ...overrides,
  };
}

function renderSessionItem(overrides: Partial<ComponentProps<typeof SessionItem>> = {}) {
  const onArchive = vi.fn();
  const onSelect = vi.fn();

  const view = render(
    <SessionItem
      session={makeSession()}
      isActive={false}
      isArchived={false}
      sessionName="Session"
      sessionPreview="preview"
      permCount={0}
      isRecentlyRenamed={false}
      onSelect={onSelect}
      onStartRename={vi.fn()}
      onArchive={onArchive}
      onUnarchive={vi.fn()}
      onDelete={vi.fn()}
      onClearRecentlyRenamed={vi.fn()}
      editingSessionId={null}
      editingName=""
      setEditingName={vi.fn()}
      onConfirmRename={vi.fn()}
      onCancelRename={vi.fn()}
      editInputRef={{ current: null }}
      {...overrides}
    />,
  );

  return {
    ...view,
    onArchive,
    onSelect,
  };
}

function EditingSessionItem({
  onConfirmRename = vi.fn(),
  onCancelRename = vi.fn(),
}: {
  onConfirmRename?: ReturnType<typeof vi.fn>;
  onCancelRename?: ReturnType<typeof vi.fn>;
}) {
  const [editingName, setEditingName] = useState("Session");

  return (
    <SessionItem
      session={makeSession()}
      isActive={false}
      isArchived={false}
      sessionName="Session"
      sessionPreview="preview"
      permCount={0}
      isRecentlyRenamed={false}
      onSelect={vi.fn()}
      onStartRename={vi.fn()}
      onArchive={vi.fn()}
      onUnarchive={vi.fn()}
      onDelete={vi.fn()}
      onClearRecentlyRenamed={vi.fn()}
      editingSessionId="s1"
      editingName={editingName}
      setEditingName={setEditingName}
      onConfirmRename={onConfirmRename as () => void}
      onCancelRename={onCancelRename as () => void}
      editInputRef={{ current: null }}
    />
  );
}

function setSessionNotifications(sessionId: string, notifications: Array<any>) {
  mockStoreState.sessionNotifications.set(sessionId, notifications);
}

function setSessionTimers(sessionId: string, timerIds: string[]) {
  mockStoreState.sessionTimers.set(
    sessionId,
    timerIds.map((id) => ({ id })),
  );
}

const SAGE_THEME: HerdGroupBadgeTheme = {
  token: "sage",
  textColor: "rgb(159, 214, 172)",
  borderColor: "rgba(119, 191, 139, 0.34)",
  leaderBackground: "rgba(119, 191, 139, 0.16)",
  herdBackground: "rgba(119, 191, 139, 0.1)",
};

beforeEach(() => {
  mockRefreshSessionGitStatus.mockClear();
  mockRefreshSessionGitStatus.mockResolvedValue({
    ok: true,
    gitBranch: "main",
    gitDefaultBranch: "main",
    diffBaseBranch: "main",
    gitAhead: 0,
    gitBehind: 0,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    gitStatusRefreshedAt: 123,
    gitStatusRefreshError: null,
  });
});

describe("SessionItem swipe archive", () => {
  it("archives on right swipe in normal mode", () => {
    const { getByText, onArchive } = renderSessionItem();
    const item = getByText("Session").closest("button")!;

    fireEvent.touchStart(item, { touches: [{ clientX: 80, clientY: 40 }] });
    fireEvent.touchMove(item, { touches: [{ clientX: 170, clientY: 42 }] });
    fireEvent.touchEnd(item);

    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(onArchive.mock.calls[0][1]).toBe("s1");
  });

  it("archives on left swipe in normal mode", () => {
    const { getByText, onArchive } = renderSessionItem();
    const item = getByText("Session").closest("button")!;

    fireEvent.touchStart(item, { touches: [{ clientX: 180, clientY: 40 }] });
    fireEvent.touchMove(item, { touches: [{ clientX: 90, clientY: 38 }] });
    fireEvent.touchEnd(item);

    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(onArchive.mock.calls[0][1]).toBe("s1");
  });

  it("disables swipe archive while reorder mode is active", () => {
    const { getByText, onArchive } = renderSessionItem({ reorderMode: true });
    const item = getByText("Session").closest("button")!;

    fireEvent.touchStart(item, { touches: [{ clientX: 80, clientY: 40 }] });
    fireEvent.touchMove(item, { touches: [{ clientX: 170, clientY: 42 }] });
    fireEvent.touchEnd(item);

    expect(onArchive).not.toHaveBeenCalled();
  });

  it("does not select the session when the mobile reorder handle is tapped", () => {
    const { onSelect } = renderSessionItem({
      reorderMode: true,
      onMobileReorderHandleActiveChange: vi.fn(),
      dragHandleProps: {},
    });

    const handle = screen.getByTestId("session-drag-handle-s1");
    fireEvent.click(handle);

    expect(onSelect).not.toHaveBeenCalled();
    expect(handle).toHaveClass("touch-none");
  });
});

describe("SessionItem archive confirmation copy", () => {
  it("shows the worktree warning when confirming a worktree archive", () => {
    renderSessionItem({
      archiveConfirmation: { sessionId: "s1", kind: "worktree" },
      onConfirmArchive: vi.fn(),
      onCancelArchive: vi.fn(),
    });

    expect(screen.getByText(/delete the worktree/i)).toBeInTheDocument();
  });

  it("shows the leader warning with the active worker count", () => {
    renderSessionItem({
      session: makeSession({ isOrchestrator: true }),
      archiveConfirmation: { sessionId: "s1", kind: "leader", activeWorkerCount: 2 },
      onConfirmArchive: vi.fn(),
      onCancelArchive: vi.fn(),
    });

    expect(screen.getByText(/archive only this leader/i)).toBeInTheDocument();
    expect(screen.getByText(/2 active herd member sessions/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive Leader Only" })).toBeInTheDocument();
  });

  it("offers a leader plus herd archive action when the caller provides one", () => {
    const onConfirmArchive = vi.fn();
    const onConfirmArchiveHerdMembers = vi.fn();
    renderSessionItem({
      session: makeSession({ isOrchestrator: true }),
      archiveConfirmation: { sessionId: "s1", kind: "leader", activeWorkerCount: 2 },
      onConfirmArchive,
      onConfirmArchiveHerdMembers,
      onCancelArchive: vi.fn(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Archive Leader Only" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive Leader + Herd" }));

    expect(onConfirmArchive).toHaveBeenCalledTimes(1);
    expect(onConfirmArchiveHerdMembers).toHaveBeenCalledTimes(1);
  });

  it("preserves the worktree warning for leader archive choices", () => {
    renderSessionItem({
      session: makeSession({ isOrchestrator: true, isWorktree: true }),
      archiveConfirmation: {
        sessionId: "s1",
        kind: "leader",
        activeWorkerCount: 2,
        leaderArchiveDestructiveTarget: "worktree",
      },
      onConfirmArchive: vi.fn(),
      onConfirmArchiveHerdMembers: vi.fn(),
      onCancelArchive: vi.fn(),
    });

    expect(screen.getByText(/delete this leader's worktree/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive Leader Only" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive Leader + Herd" })).toBeInTheDocument();
  });
});

describe("SessionItem archived worktree cleanup status", () => {
  it("shows pending cleanup tooltip for archived worktrees", () => {
    // Protects the new async archive UX: users need a clear explanation that
    // archive succeeded but background worktree deletion is still running.
    renderSessionItem({
      session: makeSession({ archived: true, isWorktree: true, worktreeCleanupStatus: "pending" }),
      isArchived: true,
    });

    expect(screen.getByText("wt")).toHaveAttribute("title", "Worktree cleanup is still running");
  });

  it("shows failed cleanup tooltip for archived worktrees", () => {
    // Protects the surfaced failure path so an archive doesn't look half-done
    // with no reason when background worktree cleanup fails.
    renderSessionItem({
      session: makeSession({
        archived: true,
        isWorktree: true,
        worktreeCleanupStatus: "failed",
        worktreeCleanupError: "git worktree remove failed",
      }),
      isArchived: true,
    });

    expect(screen.getByText("wt")).toHaveAttribute("title", "git worktree remove failed");
  });
});

describe("SessionItem rename mode", () => {
  it("keeps the rename input outside the clickable row button so spaces do not trigger row activation", () => {
    // Regression guard for q-676: the rename input must not be nested inside the
    // row button, because Space can activate buttons and collapse edit mode.
    const onConfirmRename = vi.fn();
    const onCancelRename = vi.fn();

    render(<EditingSessionItem onConfirmRename={onConfirmRename} onCancelRename={onCancelRename} />);
    const input = screen.getByDisplayValue("Session");

    input.focus();
    fireEvent.change(input, { target: { value: "Session Name" } });
    fireEvent.keyDown(input, { key: " " });

    expect(input.closest("button")).toBeNull();
    expect(screen.getByDisplayValue("Session Name")).toBeInTheDocument();
    expect(document.activeElement).toBe(input);
    expect(onConfirmRename).not.toHaveBeenCalled();
    expect(onCancelRename).not.toHaveBeenCalled();
  });
});

describe("SessionItem search match context", () => {
  it("shows matched field label and highlights matched query text", () => {
    renderSessionItem({
      matchContext: "message: fix beta auth bug",
      matchedField: "user_message",
      matchQuery: "beta",
    });

    expect(screen.getByText("message:")).toBeInTheDocument();
    const highlight = screen.getByText("beta");
    expect(highlight.tagName).toBe("MARK");
    expect(screen.getByText(/fix/i)).toBeInTheDocument();
  });

  it("falls back to session name snippet for name matches without matchContext", () => {
    renderSessionItem({
      sessionName: "Beta Session",
      matchContext: null,
      matchedField: "name",
      matchQuery: "beta",
    });

    expect(screen.getByText("name:")).toBeInTheDocument();
    const highlight = screen.getByText("Beta");
    expect(highlight.tagName).toBe("MARK");
  });

  it("falls back to the numeric session label for exact session-number matches", () => {
    renderSessionItem({
      session: makeSession({ sessionNum: 12 }),
      matchContext: null,
      matchedField: "session_number",
      matchQuery: "#0012",
    });

    const matchLine = screen.getByText("session:").parentElement;
    expect(matchLine).not.toBeNull();
    expect(matchLine).toHaveTextContent("#12");
  });
});

describe("SessionItem herd role badges", () => {
  it("renders a themed leader badge for leader sessions", () => {
    // Leader badges only render in status-bar row variants; herd-group rows
    // already communicate leadership structurally.
    renderSessionItem({
      session: makeSession({ isOrchestrator: true }),
      herdGroupBadgeTheme: SAGE_THEME,
      useStatusBar: true,
    });

    const badge = screen.getByText("leader");
    expect(badge).toHaveAttribute("data-herd-group-tone", "sage");
    expect(badge).toHaveStyle({ color: SAGE_THEME.textColor });
    expect(badge).toHaveStyle({ backgroundColor: SAGE_THEME.leaderBackground });
  });

  it("renders a themed herd badge for worker sessions", () => {
    renderSessionItem({
      session: makeSession({ herdedBy: "leader-1" }),
      herdGroupBadgeTheme: SAGE_THEME,
    });

    const badge = screen.getByText("herd");
    expect(badge).toHaveAttribute("data-herd-group-tone", "sage");
    expect(badge).toHaveStyle({ color: SAGE_THEME.textColor });
    expect(badge).toHaveStyle({ backgroundColor: SAGE_THEME.herdBackground });
  });
});

describe("SessionItem status dot", () => {
  beforeEach(() => {
    mockStoreState.sessionTimers.clear();
    mockStoreState.currentSessionId = "s1";
  });

  it("shows a breathing green dot while running", () => {
    renderSessionItem({
      session: makeSession({
        status: "running",
        sdkState: "running",
      }),
    });

    const dot = screen.getByTestId("session-status-dot");
    expect(dot).toHaveAttribute("data-status", "running");
    expect(dot).toHaveStyle({ animation: "yarn-glow-breathe 2s ease-in-out infinite" });
  });

  it("shows a glowing amber dot when permissions are pending", () => {
    renderSessionItem({
      session: makeSession({ status: "idle", sdkState: "connected" }),
      permCount: 2,
    });

    const dot = screen.getByTestId("session-status-dot");
    expect(dot).toHaveAttribute("data-status", "permission");
    expect(dot).toHaveStyle({ animation: "yarn-glow-breathe 2s ease-in-out infinite" });
  });

  it("shows a gray dot when idle", () => {
    renderSessionItem({
      session: makeSession({ status: "idle", sdkState: "connected" }),
      permCount: 0,
    });

    const dot = screen.getByTestId("session-status-dot");
    expect(dot).toHaveAttribute("data-status", "idle");
    expect(dot).not.toHaveStyle({ animation: "yarn-glow-breathe 2s ease-in-out infinite" });
  });

  it("replaces the idle dot with a timer icon when the session is waiting on timers", () => {
    // Idle sessions with scheduled timers should advertise that waiting state
    // in the primary status slot instead of the old hover-hidden side badge.
    setSessionTimers("s1", ["t1", "t2"]);

    const { container } = renderSessionItem({
      session: makeSession({ status: "idle", sdkState: "connected" }),
      permCount: 0,
    });

    const timerIcon = screen.getByTestId("session-status-timer-icon");
    expect(timerIcon).toHaveAttribute("data-count", "2");
    expect(timerIcon).toHaveAttribute("title", "2 scheduled timers");
    expect(container.querySelector('[data-testid="session-status-dot"]')).toBeNull();
  });

  it("uses the dedicated alignment classes for the timer icon slot", () => {
    setSessionTimers("s1", ["t1"]);

    renderSessionItem({
      session: makeSession({ status: "idle", sdkState: "connected" }),
      permCount: 0,
    });

    const timerIcon = screen.getByTestId("session-status-timer-icon");
    expect(timerIcon.className).toContain("h-3");
    expect(timerIcon.className).toContain("w-3");
    expect(timerIcon.className).toContain("leading-none");
    expect(timerIcon.firstElementChild).toHaveClass("-translate-y-px");
  });

  it("shows the timer icon in status-bar sidebar rows too", () => {
    // Status-bar rows use the left status stripe instead of the dot, so the
    // timer state still needs an inline icon to stay visible there.
    setSessionTimers("s1", ["t1"]);

    renderSessionItem({
      session: makeSession({ status: "idle", sdkState: "connected" }),
      permCount: 0,
      useStatusBar: true,
    });

    const timerIcon = screen.getByTestId("session-status-timer-icon");
    expect(timerIcon).toHaveAttribute("title", "1 scheduled timer");
  });

  it("uses the polled session snapshot timer count for non-selected rows", () => {
    // Non-current sidebar rows do not keep a live socket open, so they should
    // still advertise scheduled work from the server-polled session snapshot.
    mockStoreState.currentSessionId = "other-session";

    renderSessionItem({
      session: makeSession({ pendingTimerCount: 1 }),
      permCount: 0,
    });

    const timerIcon = screen.getByTestId("session-status-timer-icon");
    expect(timerIcon).toHaveAttribute("title", "1 scheduled timer");
  });

  it("prefers the live current-session timer state over a stale snapshot count", () => {
    // When viewing the session directly, the live timer store must win so a
    // cancelled timer clears immediately instead of waiting for the next poll.
    mockStoreState.currentSessionId = "s1";

    const { container } = renderSessionItem({
      session: makeSession({ pendingTimerCount: 2 }),
      permCount: 0,
    });

    expect(container.querySelector('[data-testid="session-status-timer-icon"]')).toBeNull();
    expect(screen.getByTestId("session-status-dot")).toHaveAttribute("data-status", "idle");
  });
});

describe("SessionItem git status refresh", () => {
  it("shows a stale manual refresh control and calls the refresh API without selecting the session", async () => {
    const onSelect = vi.fn();
    renderSessionItem({
      session: makeSession({
        gitAhead: 3,
        linesAdded: 42,
        gitStatusRefreshedAt: Date.now() - 10 * 60_000,
      }),
      onSelect,
    });

    const refresh = screen.getByTestId("session-git-refresh");
    expect(refresh).toHaveAttribute("data-stale", "true");
    expect(refresh.getAttribute("title")).toContain("Last refreshed");

    fireEvent.click(refresh);

    await waitFor(() => expect(mockRefreshSessionGitStatus).toHaveBeenCalledWith("s1"));
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("SessionItem notification marker", () => {
  beforeEach(() => {
    mockStoreState.sessionAttention.clear();
    mockStoreState.sessionNotifications.clear();
    mockStoreState.sessionTimers.clear();
    mockStoreState.sdkSessions = [];
  });

  it("shows a blue notification marker when review is the highest active inbox urgency", () => {
    // When there are only active review notifications and no higher-priority
    // badges, the inline session marker should use the blue review color.
    setSessionNotifications("s1", [
      { id: "n-review", category: "review", summary: "Needs review", timestamp: Date.now(), done: false },
      { id: "n-review-done", category: "review", summary: "Done review", timestamp: Date.now(), done: true },
    ]);

    renderSessionItem();
    const marker = screen.getByTestId("session-notification-marker");
    expect(marker).toHaveAttribute("data-urgency", "review");
  });

  it("gives needs-input precedence over review in the inline notification marker", () => {
    // needs-input should take precedence over review for the second consumer
    // of the shared urgency helper, matching the notification bell behavior.
    setSessionNotifications("s1", [
      { id: "n-review", category: "review", summary: "Needs review", timestamp: Date.now(), done: false },
      { id: "n-input", category: "needs-input", summary: "Need answer", timestamp: Date.now(), done: false },
    ]);

    renderSessionItem();
    const marker = screen.getByTestId("session-notification-marker");
    expect(marker).toHaveAttribute("data-urgency", "needs-input");
  });

  it("does not fall back to a stale snapshot marker after the live inbox is known cleared", () => {
    // A loaded empty inbox is authoritative for the session row. Falling back to
    // an older /api/sessions amber marker would resurrect a resolved needs-input dot.
    setSessionNotifications("s1", []);
    mockStoreState.sdkSessions = [
      {
        sessionId: "s1",
        notificationUrgency: null,
        activeNotificationCount: 0,
        notificationStatusVersion: 5,
      },
    ];

    const { container } = renderSessionItem({
      session: makeSession({ notificationUrgency: "needs-input", activeNotificationCount: 1 }),
    });

    expect(container.querySelector('[data-testid="session-notification-marker"]')).toBeNull();
  });

  it("ignores stale active full-inbox data when a newer clear summary is known", () => {
    // A browser can have an old full notification inbox from a previous visit
    // while global fanout has already delivered a newer lightweight clear.
    // The sidebar marker must follow the newer clear summary.
    setSessionNotifications("s1", [
      { id: "n-input", category: "needs-input", summary: "Need answer", timestamp: Date.now(), done: false },
    ]);
    mockStoreState.sdkSessions = [
      {
        sessionId: "s1",
        notificationUrgency: null,
        activeNotificationCount: 0,
        notificationStatusVersion: 5,
        notificationStatusUpdatedAt: 5000,
      },
    ];

    const { container } = renderSessionItem();

    expect(container.querySelector('[data-testid="session-notification-marker"]')).toBeNull();
  });

  it("uses a newer active summary over stale review-only full-inbox data", () => {
    // The notification chip and session row can hold an older full inbox while
    // global fanout has already delivered the latest lightweight needs-input
    // status. The row must keep showing amber, not fall back to blue review.
    setSessionNotifications("s1", [
      { id: "n-review", category: "review", summary: "Review", timestamp: Date.now(), done: false },
    ]);
    mockStoreState.sdkSessions = [
      {
        sessionId: "s1",
        notificationUrgency: "needs-input",
        activeNotificationCount: 1,
        notificationStatusVersion: 6,
        notificationStatusUpdatedAt: 6000,
      },
    ];

    renderSessionItem();

    const marker = screen.getByTestId("session-notification-marker");
    expect(marker).toHaveAttribute("data-urgency", "needs-input");
  });

  it("does not render stale action attention after notification status is known cleared", () => {
    // A stale action attention value should not render the same amber dot after
    // the versioned notification summary has already cleared the inbox.
    const { container } = renderSessionItem({
      attention: "action",
      hasUnread: true,
      session: makeSession({
        notificationUrgency: null,
        activeNotificationCount: 0,
        notificationStatusVersion: 5,
      }),
    });

    expect(container.querySelector(".bg-amber-400")).toBeNull();
  });

  it("keeps rendering action attention when notification status is still active", () => {
    // The render guard is only for stale cleared summaries; current needs-input
    // action attention should still produce the visible amber badge.
    const { container } = renderSessionItem({
      attention: "action",
      session: makeSession({
        notificationUrgency: "needs-input",
        activeNotificationCount: 1,
        notificationStatusVersion: 5,
      }),
    });

    expect(container.querySelector(".bg-amber-400")).not.toBeNull();
  });

  it("suppresses the inbox marker when a higher-priority attention badge is already active", () => {
    // The session-level attention badge should continue to win over the inbox
    // marker so the shared urgency helper does not bypass existing precedence.
    setSessionNotifications("s1", [
      { id: "n-review", category: "review", summary: "Needs review", timestamp: Date.now(), done: false },
    ]);

    const { container } = renderSessionItem({ attention: "action" });
    expect(container.querySelector('[data-testid="session-notification-marker"]')).toBeNull();
  });

  it("uses the status icon instead of a side badge when timers exist", () => {
    // A timed but otherwise idle session should use the primary status slot
    // rather than a hover-hidden side badge.
    setSessionTimers("s1", ["t1", "t2"]);

    const { container } = renderSessionItem();

    const icon = screen.getByTestId("session-status-timer-icon");
    expect(icon).toHaveAttribute("data-count", "2");
    expect(container.querySelector('[data-testid="session-notification-marker"]')).toBeNull();
  });

  it("suppresses the timer icon when a stronger permission badge is active", () => {
    // Pending permissions should continue to own the badge lane because they
    // require immediate user attention.
    setSessionTimers("s1", ["t1"]);

    const { container } = renderSessionItem({ permCount: 1 });
    expect(container.querySelector('[data-testid="session-status-timer-icon"]')).toBeNull();
  });

  it("shows the timer icon instead of the lower-priority inbox marker", () => {
    // Timers should beat passive inbox markers so sessions with scheduled work
    // are still discoverable without hiding stronger action/review badges.
    setSessionNotifications("s1", [
      { id: "n-review", category: "review", summary: "Needs review", timestamp: Date.now(), done: false },
    ]);
    setSessionTimers("s1", ["t1"]);

    const { container } = renderSessionItem();
    expect(container.querySelector('[data-testid="session-status-timer-icon"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="session-notification-marker"]')).toBeNull();
  });

  it("preserves needs-input precedence when timers are also present", () => {
    // Urgent needs-input inbox markers must still win over the timer badge so
    // sessions that require a human response remain immediately visible.
    setSessionNotifications("s1", [
      { id: "n-input", category: "needs-input", summary: "Need answer", timestamp: Date.now(), done: false },
    ]);
    setSessionTimers("s1", ["t1"]);

    const { container } = renderSessionItem();
    const marker = screen.getByTestId("session-notification-marker");
    expect(marker).toHaveAttribute("data-urgency", "needs-input");
    expect(container.querySelector('[data-testid="session-status-timer-icon"]')).toBeNull();
  });
});

describe("SessionItem reviewer badge", () => {
  // Tests for the inline reviewer badge that appears on the parent session's
  // metadata row (Row 3) when an active reviewer session exists. The badge
  // replaces the old indented reviewer row with a compact clickable indicator.

  beforeEach(() => {
    mockNavigateToSession.mockReset();
  });

  it("renders a review badge when reviewerSession is provided", () => {
    // The parent session (sessionNum: 8) should show a "review" badge when
    // it has an active reviewer session linked via reviewerOf.
    const reviewer = makeSession({ id: "reviewer-1", sessionNum: 42, reviewerOf: 8 });
    renderSessionItem({
      session: makeSession({ sessionNum: 8 }),
      reviewerSession: reviewer,
    });

    const badge = screen.getByTestId("session-reviewer-badge");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("review");
  });

  it("does not render a review badge when reviewerSession is undefined", () => {
    // Sessions without an active reviewer should not display any badge.
    renderSessionItem({
      session: makeSession({ sessionNum: 8 }),
    });

    expect(screen.queryByTestId("session-reviewer-badge")).not.toBeInTheDocument();
  });

  it("navigates to the reviewer session on badge click without selecting the parent", () => {
    // Clicking the badge should open the reviewer session directly via
    // navigateToSession, not trigger the parent row's onSelect handler.
    // stopPropagation prevents the click from bubbling to the parent button.
    const reviewer = makeSession({ id: "reviewer-1", sessionNum: 42, reviewerOf: 8 });
    const { onSelect } = renderSessionItem({
      session: makeSession({ sessionNum: 8 }),
      reviewerSession: reviewer,
    });

    fireEvent.click(screen.getByTestId("session-reviewer-badge"));

    expect(mockNavigateToSession).toHaveBeenCalledWith("reviewer-1");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("uses the reviewer session as the hover preview target when the badge is hovered", () => {
    // Hovering the inline reviewer badge should override the parent row hover
    // target so the shared sidebar popover previews the reviewer session.
    const reviewer = makeSession({ id: "reviewer-1", sessionNum: 42, reviewerOf: 8 });
    const onHoverStart = vi.fn();
    renderSessionItem({
      session: makeSession({ sessionNum: 8 }),
      reviewerSession: reviewer,
      onHoverStart,
    });

    fireEvent.mouseEnter(screen.getByTestId("session-reviewer-badge"));

    expect(onHoverStart).toHaveBeenCalled();
    expect(onHoverStart.mock.calls.at(-1)?.[0]).toBe("reviewer-1");
    expect(onHoverStart.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({ top: 0, left: 0 }));
  });

  it("restores the parent hover preview when leaving the reviewer badge back into the row", () => {
    // Moving off the badge but staying inside the row should put the hover
    // card back on the parent session instead of clearing the preview.
    const reviewer = makeSession({ id: "reviewer-1", sessionNum: 42, reviewerOf: 8 });
    const onHoverStart = vi.fn();
    renderSessionItem({
      session: makeSession({ sessionNum: 8 }),
      reviewerSession: reviewer,
      onHoverStart,
    });

    const badge = screen.getByTestId("session-reviewer-badge");
    const button = screen.getByText("Session").closest("button")!;
    fireEvent.mouseLeave(badge, { relatedTarget: button });

    expect(onHoverStart).toHaveBeenCalled();
    expect(onHoverStart.mock.calls.at(-1)?.[0]).toBe("s1");
  });

  it("ends hover preview when leaving the reviewer badge away from the row", () => {
    // Exiting the badge toward the popover/outside world should use the
    // existing delayed hover-end path instead of snapping back to the parent.
    const reviewer = makeSession({ id: "reviewer-1", sessionNum: 42, reviewerOf: 8 });
    const onHoverEnd = vi.fn();
    renderSessionItem({
      session: makeSession({ sessionNum: 8 }),
      reviewerSession: reviewer,
      onHoverEnd,
    });

    fireEvent.mouseLeave(screen.getByTestId("session-reviewer-badge"), {
      relatedTarget: document.body,
    });

    expect(onHoverEnd).toHaveBeenCalledTimes(1);
  });

  it("shows reviewer session number in the title tooltip", () => {
    // When the reviewer has a sessionNum, the tooltip should include it
    // (e.g., "Reviewer #42 — click to open").
    const reviewer = makeSession({ id: "reviewer-1", sessionNum: 42, reviewerOf: 8 });
    renderSessionItem({
      session: makeSession({ sessionNum: 8 }),
      reviewerSession: reviewer,
    });

    const badge = screen.getByTestId("session-reviewer-badge");
    expect(badge).toHaveAttribute("title", "Reviewer #42 — click to open");
  });

  it("omits session number from title when reviewer has no sessionNum", () => {
    // When the reviewer session has no sessionNum (e.g., null), the tooltip
    // should gracefully omit it rather than showing "undefined" or "#null".
    const reviewer = makeSession({ id: "reviewer-1", sessionNum: undefined, reviewerOf: 8 });
    renderSessionItem({
      session: makeSession({ sessionNum: 8 }),
      reviewerSession: reviewer,
    });

    const badge = screen.getByTestId("session-reviewer-badge");
    expect(badge).toHaveAttribute("title", "Reviewer — click to open");
  });

  it("shows running status glow when reviewer is actively working", () => {
    // A running reviewer should have a green-themed badge with breathing glow
    // animation so the user can see at a glance that the review is in progress.
    const reviewer = makeSession({
      id: "reviewer-1",
      reviewerOf: 8,
      status: "running",
      sdkState: "running",
      isConnected: true,
    });
    renderSessionItem({
      session: makeSession({ sessionNum: 8 }),
      reviewerSession: reviewer,
    });

    const badge = screen.getByTestId("session-reviewer-badge");
    expect(badge).toHaveAttribute("data-reviewer-status", "running");
    expect(badge).toHaveStyle({ animation: "reviewer-badge-glow 2s ease-in-out infinite" });
  });

  it("shows permission status glow when reviewer needs approval", () => {
    // A reviewer waiting for tool permission should have an amber-themed badge
    // with breathing glow, mirroring how the main status stripe signals permission.
    const reviewer = makeSession({
      id: "reviewer-1",
      reviewerOf: 8,
      permCount: 2,
      status: "idle",
      sdkState: "connected",
      isConnected: true,
    });
    renderSessionItem({
      session: makeSession({ sessionNum: 8 }),
      reviewerSession: reviewer,
    });

    const badge = screen.getByTestId("session-reviewer-badge");
    expect(badge).toHaveAttribute("data-reviewer-status", "permission");
    expect(badge).toHaveStyle({ animation: "reviewer-badge-glow 2s ease-in-out infinite" });
  });

  it("shows no glow animation when reviewer is idle", () => {
    // An idle reviewer should display as a plain muted badge with no glow,
    // so it doesn't draw attention when nothing is happening.
    const reviewer = makeSession({
      id: "reviewer-1",
      reviewerOf: 8,
      status: "idle",
      sdkState: "connected",
      isConnected: true,
      permCount: 0,
    });
    renderSessionItem({
      session: makeSession({ sessionNum: 8 }),
      reviewerSession: reviewer,
    });

    const badge = screen.getByTestId("session-reviewer-badge");
    expect(badge).toHaveAttribute("data-reviewer-status", "idle");
    expect(badge).not.toHaveStyle({ animation: "reviewer-badge-glow 2s ease-in-out infinite" });
  });

  it("shows no glow animation when reviewer is disconnected", () => {
    // A disconnected reviewer (CLI process dropped) should fall back to the
    // gray/muted theme with no glow, same as idle -- no user action needed.
    const reviewer = makeSession({
      id: "reviewer-1",
      reviewerOf: 8,
      status: "idle",
      sdkState: "connected",
      isConnected: false,
      permCount: 0,
    });
    renderSessionItem({
      session: makeSession({ sessionNum: 8 }),
      reviewerSession: reviewer,
    });

    const badge = screen.getByTestId("session-reviewer-badge");
    expect(badge).toHaveAttribute("data-reviewer-status", "disconnected");
    expect(badge).not.toHaveStyle({ animation: "reviewer-badge-glow 2s ease-in-out infinite" });
  });

  it("shows archived status when reviewer session is archived", () => {
    // An archived reviewer should show the archived visual status (gray, no glow).
    // This verifies that the `archived` field is correctly passed to deriveSessionStatus.
    const reviewer = makeSession({
      id: "reviewer-1",
      reviewerOf: 8,
      archived: true,
      status: "idle",
      sdkState: "connected",
      isConnected: true,
      permCount: 0,
    });
    renderSessionItem({
      session: makeSession({ sessionNum: 8 }),
      reviewerSession: reviewer,
    });

    const badge = screen.getByTestId("session-reviewer-badge");
    expect(badge).toHaveAttribute("data-reviewer-status", "archived");
    expect(badge).not.toHaveStyle({ animation: "reviewer-badge-glow 2s ease-in-out infinite" });
  });
});

describe("SessionItem quest title label", () => {
  // Quest-named sessions display a checkbox prefix to indicate status:
  // ☐ for in-progress, ☑ for done.
  // Non-quest sessions show the plain name with no prefix.

  afterEach(() => {
    // Reset quest state after each test
    mockStoreState.questNamedSessions.clear();
    mockStoreState.sessions.clear();
  });

  it("shows ☐ prefix for in-progress quest sessions", () => {
    mockStoreState.questNamedSessions.add("s1");
    mockStoreState.sessions.set("s1", { claimedQuestStatus: "in_progress" });

    renderSessionItem({ sessionName: "Fix auth bug" });

    expect(screen.getByText("☐ Fix auth bug")).toBeInTheDocument();
  });

  it("shows ☑ prefix for done quest sessions under review", () => {
    mockStoreState.questNamedSessions.add("s1");
    mockStoreState.sessions.set("s1", { claimedQuestStatus: "done", claimedQuestVerificationInboxUnread: true });

    renderSessionItem({ sessionName: "Fix auth bug" });

    expect(screen.getByText("☑ Fix auth bug")).toBeInTheDocument();
  });

  it("can derive the checked prefix from sidebar session data when bridge quest state is missing", () => {
    renderSessionItem({
      sessionName: "Fix auth bug",
      session: makeSession({ claimedQuestStatus: "done", claimedQuestVerificationInboxUnread: true }),
    });

    expect(screen.getByText("☑ Fix auth bug")).toBeInTheDocument();
  });

  it("does not derive a quest checkbox prefix for orchestrator rows", () => {
    renderSessionItem({
      sessionName: "Leader 7",
      session: makeSession({ isOrchestrator: true, claimedQuestStatus: "done" }),
    });

    const span = screen.getByText("Leader 7");
    expect(span.textContent).toBe("Leader 7");
    expect(screen.queryByText("☑ Leader 7")).not.toBeInTheDocument();
    expect(screen.queryByText("☐ Leader 7")).not.toBeInTheDocument();
  });

  it("shows plain name for non-quest sessions", () => {
    renderSessionItem({ sessionName: "Regular session" });

    const span = screen.getByText("Regular session");
    expect(span.textContent).toBe("Regular session");
  });

  it("shows ☐ prefix when quest status is undefined", () => {
    // Edge case: session is quest-named but claimedQuestStatus was never set.
    // Should fall through to the ☐ branch, not crash or show ☑.
    mockStoreState.questNamedSessions.add("s1");
    mockStoreState.sessions.set("s1", { claimedQuestStatus: undefined });

    renderSessionItem({ sessionName: "Mystery quest" });

    expect(screen.getByText("☐ Mystery quest")).toBeInTheDocument();
  });

  it("shows ☐ prefix for final done quests without review metadata", () => {
    // Confirms the ☑ check is strict -- only review-pending done gets a checked box.
    mockStoreState.questNamedSessions.add("s1");
    mockStoreState.sessions.set("s1", { claimedQuestStatus: "done" });

    renderSessionItem({ sessionName: "Completed quest" });

    expect(screen.getByText("☐ Completed quest")).toBeInTheDocument();
  });
});

describe("SessionItem isDraggable cursor styling", () => {
  // When isDraggable is true (default), the session button shows a grab cursor
  // on desktop (sm breakpoint) so users know they can drag to reorder.
  it("shows grab cursor classes when isDraggable is true (default)", () => {
    renderSessionItem();
    const button = screen.getByText("Session").closest("button")!;
    expect(button.className).toContain("sm:cursor-grab");
    expect(button.className).toContain("sm:active:cursor-grabbing");
  });

  // When isDraggable is false (activity sort mode), the grab cursor is removed
  // to signal that reordering is server-controlled and not user-draggable.
  it("hides grab cursor classes when isDraggable is false", () => {
    renderSessionItem({ isDraggable: false });
    const button = screen.getByText("Session").closest("button")!;
    expect(button.className).not.toContain("sm:cursor-grab");
    expect(button.className).not.toContain("sm:active:cursor-grabbing");
    expect(button.className).toContain("cursor-pointer");
  });
});
