// @vitest-environment jsdom
import { render, fireEvent, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { ComponentProps } from "react";
import type { SessionItem as SessionItemType } from "../utils/project-grouping.js";
import type { HerdGroupBadgeTheme } from "../utils/herd-group-theme.js";

const mockStoreState = {
  questNamedSessions: new Set<string>(),
  sessions: new Map<string, { claimedQuestStatus?: string }>(),
  sessionTaskPreview: new Map<string, { text: string; updatedAt: number }>(),
  sessionPreviewUpdatedAt: new Map<string, number>(),
  sessionAttention: new Map<string, "action" | "error" | "review" | null>(),
  sessionNotifications: new Map<string, Array<any>>(),
};

vi.mock("../store.js", () => ({
  useStore: (selector: (state: typeof mockStoreState) => unknown) => selector(mockStoreState),
}));

const mockNavigateToSession = vi.fn();
vi.mock("../utils/routing.js", () => ({
  navigateToSession: (...args: unknown[]) => mockNavigateToSession(...args),
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

function setSessionNotifications(sessionId: string, notifications: Array<any>) {
  mockStoreState.sessionNotifications.set(sessionId, notifications);
}

const SAGE_THEME: HerdGroupBadgeTheme = {
  token: "sage",
  textColor: "rgb(159, 214, 172)",
  borderColor: "rgba(119, 191, 139, 0.34)",
  leaderBackground: "rgba(119, 191, 139, 0.16)",
  herdBackground: "rgba(119, 191, 139, 0.1)",
};

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

    expect(screen.getByText(/detach 2 active worker sessions/i)).toBeInTheDocument();
    expect(screen.getByText(/leave them running without a leader/i)).toBeInTheDocument();
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
});

describe("SessionItem herd role badges", () => {
  it("renders a themed leader badge for leader sessions", () => {
    // Leader badge is only shown in linear view (useStatusBar=true);
    // in tree view, tree structure already communicates leadership.
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
});

describe("SessionItem notification marker", () => {
  beforeEach(() => {
    mockStoreState.sessionAttention.clear();
    mockStoreState.sessionNotifications.clear();
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

  it("suppresses the inbox marker when a higher-priority attention badge is already active", () => {
    // The session-level attention badge should continue to win over the inbox
    // marker so the shared urgency helper does not bypass existing precedence.
    setSessionNotifications("s1", [
      { id: "n-review", category: "review", summary: "Needs review", timestamp: Date.now(), done: false },
    ]);

    const { container } = renderSessionItem({ attention: "action" });
    expect(container.querySelector('[data-testid="session-notification-marker"]')).toBeNull();
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
  // ☐ for in-progress, ☑ for needs_verification.
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

  it("shows ☑ prefix for needs_verification quest sessions", () => {
    mockStoreState.questNamedSessions.add("s1");
    mockStoreState.sessions.set("s1", { claimedQuestStatus: "needs_verification" });

    renderSessionItem({ sessionName: "Fix auth bug" });

    expect(screen.getByText("☑ Fix auth bug")).toBeInTheDocument();
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

  it("shows ☐ prefix for non-verification statuses like 'done'", () => {
    // Confirms the ☑ check is strict -- only "needs_verification" gets a checked box.
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
