// @vitest-environment jsdom
import { fireEvent, render, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { ReactNode } from "react";

interface MockStoreState {
  pendingPermissions: Map<string, Map<string, { tool_name?: string; request_id?: string }>>;
  connectionStatus: Map<string, "connecting" | "connected" | "disconnected">;
  sessions: Map<
    string,
    {
      backend_state?: "initializing" | "resuming" | "recovering" | "connected" | "disconnected" | "broken";
      backend_error?: string | null;
      isOrchestrator?: boolean;
    }
  >;
  cliConnected: Map<string, boolean>;
  cliEverConnected: Map<string, boolean>;
  cliDisconnectReason: Map<string, "idle_limit" | "broken" | null>;
  sessionStatus: Map<string, "idle" | "running" | "compacting" | "reverting" | null>;
  sdkSessions: Array<{
    sessionId: string;
    archived?: boolean;
    isOrchestrator?: boolean;
    sessionNum?: number;
    state?: "starting" | "connected" | "running" | "exited";
    cliConnected?: boolean;
  }>;
  sessionAttention: Map<string, "action" | "error" | "review" | null>;
  sessionBoards: Map<string, unknown[]>;
  sessionCompletedBoards: Map<string, unknown[]>;
  sessionBoardRowStatuses: Map<string, Record<string, import("../types.js").BoardRowSessionStatus>>;
  messages: Map<string, unknown[]>;
  quests: Array<{ questId: string; title: string; status: string }>;
  zoomLevel: number;
  openQuestOverlay: (questId: string) => void;
}

let mockState: MockStoreState;
const mockUnarchiveSession = vi.fn().mockResolvedValue({});
const mockRelaunchSession = vi.fn().mockResolvedValue({});
const mockOpenQuestOverlay = vi.fn();
function resetStore(overrides: Partial<MockStoreState> = {}) {
  mockState = {
    pendingPermissions: new Map(),
    connectionStatus: new Map([["s1", "connected"]]),
    sessions: new Map([["s1", { backend_state: "connected", backend_error: null }]]),
    cliConnected: new Map([["s1", true]]),
    cliEverConnected: new Map([["s1", true]]),
    cliDisconnectReason: new Map([["s1", null]]),
    sessionStatus: new Map([["s1", "idle"]]),
    sdkSessions: [{ sessionId: "s1", archived: false }],
    sessionAttention: new Map(),
    sessionBoards: new Map(),
    sessionCompletedBoards: new Map(),
    sessionBoardRowStatuses: new Map(),
    messages: new Map(),
    quests: [],
    zoomLevel: 1,
    openQuestOverlay: mockOpenQuestOverlay,
    ...overrides,
  };
}

vi.mock("../store.js", () => ({
  useStore: (selector: (s: MockStoreState) => unknown) => {
    // Simulates the useSyncExternalStore stability check so selectors do not
    // reintroduce fresh empty arrays/objects that can loop in React.
    const selected = selector(mockState);
    const repeated = selector(mockState);
    if (!Object.is(selected, repeated)) {
      throw new Error("Unstable useStore selector result");
    }
    return selected;
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

vi.mock("../hooks/useSessionSearch.js", () => ({
  useSessionSearch: () => {},
}));

vi.mock("./SearchBar.js", () => ({
  SearchBar: () => null,
}));

vi.mock("../api.js", () => ({
  api: {
    relaunchSession: (...args: unknown[]) => mockRelaunchSession(...args),
    unarchiveSession: (...args: unknown[]) => mockUnarchiveSession(...args),
  },
}));

vi.mock("./MessageFeed.js", () => ({
  MessageFeed: ({
    sessionId,
    threadKey,
    latestIndicatorMode,
  }: {
    sessionId: string;
    threadKey?: string;
    latestIndicatorMode?: string;
  }) => (
    <div data-testid="message-feed" data-thread-key={threadKey} data-latest-indicator-mode={latestIndicatorMode}>
      {sessionId}
    </div>
  ),
}));

vi.mock("./Composer.js", () => ({
  Composer: ({ threadKey, questId }: { threadKey?: string; questId?: string }) => (
    <div data-testid="composer" data-thread-key={threadKey} data-quest-id={questId} />
  ),
}));

vi.mock("./PermissionBanner.js", () => ({
  PermissionBanner: () => <div data-testid="permission-banner" />,
  PlanReviewOverlay: () => <div data-testid="plan-review-overlay" />,
  PlanCollapsedChip: () => <div data-testid="plan-collapsed-chip" />,
  PermissionsCollapsedChip: () => <div data-testid="permissions-collapsed-chip" />,
}));

vi.mock("./TaskOutlineBar.js", () => ({
  TaskOutlineBar: () => <div data-testid="task-outline-bar" />,
}));

vi.mock("./TodoStatusLine.js", () => ({
  TodoStatusLine: () => <div data-testid="todo-status-line" />,
}));

vi.mock("./WorkBoardBar.js", () => ({
  WorkBoardBar: ({
    currentThreadKey,
    currentThreadLabel,
    onReturnToMain,
  }: {
    currentThreadKey?: string;
    currentThreadLabel?: string;
    onReturnToMain?: () => void;
  }) => (
    <div
      data-testid="work-board-bar"
      data-current-thread-key={currentThreadKey}
      data-current-thread-label={currentThreadLabel}
    >
      {onReturnToMain && (
        <button type="button" onClick={onReturnToMain}>
          Return to Main
        </button>
      )}
    </div>
  ),
}));

vi.mock("./CatIcons.js", () => ({
  YarnBallDot: () => <span data-testid="yarnball-dot" />,
}));

vi.mock("./QuestInlineLink.js", () => ({
  QuestInlineLink: ({
    questId,
    children,
    className,
    stopPropagation,
  }: {
    questId: string;
    children?: ReactNode;
    className?: string;
    stopPropagation?: boolean;
  }) => (
    <a href={`#quest-${questId}`} className={className} data-stop-propagation={stopPropagation ? "true" : "false"}>
      {children ?? questId}
    </a>
  ),
}));

vi.mock("./SessionInlineLink.js", () => ({
  SessionInlineLink: ({
    sessionNum,
    children,
    className,
  }: {
    sessionNum?: number | null;
    children: ReactNode;
    className?: string;
  }) => (
    <a href={`#session-${sessionNum ?? "unknown"}`} className={className}>
      {children}
    </a>
  ),
}));

vi.mock("./SessionStatusDot.js", () => ({
  SessionStatusDot: ({
    isConnected,
    sdkState,
    status,
    archived,
  }: {
    isConnected: boolean;
    sdkState?: string | null;
    status?: string | null;
    archived?: boolean;
  }) => {
    const visualStatus = archived
      ? "archived"
      : !isConnected && sdkState !== "starting"
        ? "disconnected"
        : status || "idle";
    return <span data-testid="session-status-dot" data-status={visualStatus} />;
  },
}));

vi.mock("./QuestJourneyTimeline.js", () => ({
  isCompletedJourneyPresentationStatus: (status?: string | null) => {
    const normalized = (status ?? "").trim().toLowerCase();
    return normalized === "done" || normalized === "completed" || normalized === "needs_verification";
  },
  QuestJourneyPreviewCard: ({ quest }: { quest?: { questId: string; title?: string } }) => (
    <div data-testid="quest-journey-preview-card">{quest?.questId}</div>
  ),
}));

import { ChatView } from "./ChatView.js";

beforeEach(() => {
  resetStore();
  mockUnarchiveSession.mockClear();
  mockRelaunchSession.mockClear();
  mockOpenQuestOverlay.mockClear();
});

describe("ChatView archived banner", () => {
  it("renders archived banner and triggers unarchive action", () => {
    // Validates that archived-session state is surfaced directly in chat
    // and that the banner action sends the unarchive API request.
    resetStore({
      sdkSessions: [{ sessionId: "s1", archived: true }],
    });

    const view = render(<ChatView sessionId="s1" />);
    const scope = within(view.container);

    expect(scope.getByText("This session is archived.")).toBeInTheDocument();
    fireEvent.click(scope.getByRole("button", { name: "Unarchive" }));
    expect(mockUnarchiveSession).toHaveBeenCalledWith("s1");
  });

  it("does not render archived banner for active sessions", () => {
    // Guards against false positives: non-archived sessions should keep
    // the existing chat chrome without the archival warning banner.
    resetStore({
      sdkSessions: [{ sessionId: "s1", archived: false }],
    });

    const view = render(<ChatView sessionId="s1" />);
    const scope = within(view.container);
    expect(scope.queryByText("This session is archived.")).not.toBeInTheDocument();
  });
});

describe("ChatView backend banners", () => {
  it("shows the startup banner for a freshly launched session even without explicit backend_state", () => {
    // Claude/SDK sessions do not always populate backend_state during startup,
    // so the banner still needs to key off the first-connect path.
    resetStore({
      sessions: new Map([["s1", { backend_state: "disconnected", backend_error: null }]]),
      cliConnected: new Map([["s1", false]]),
      cliEverConnected: new Map(),
    });

    const view = render(<ChatView sessionId="s1" />);
    const scope = within(view.container);
    expect(scope.getByText("Starting session...")).toBeInTheDocument();
  });

  it("shows the broken-session banner and relaunch action", () => {
    // Broken Codex sessions should stay visibly broken until the user relaunches,
    // rather than falling back to the generic disconnected banner.
    resetStore({
      sessions: new Map([
        ["s1", { backend_state: "broken", backend_error: "Codex initialization failed: Transport closed" }],
      ]),
      cliConnected: new Map([["s1", false]]),
      cliEverConnected: new Map([["s1", true]]),
      cliDisconnectReason: new Map([["s1", "broken"]]),
      sessionStatus: new Map([["s1", null]]),
    });

    const view = render(<ChatView sessionId="s1" />);
    const scope = within(view.container);
    expect(scope.getByText("Codex initialization failed: Transport closed")).toBeInTheDocument();
    fireEvent.click(scope.getByRole("button", { name: "Relaunch" }));
    expect(mockRelaunchSession).toHaveBeenCalledWith("s1");
  });

  it("shows a recovering banner instead of the generic disconnected banner during auto-relaunch", () => {
    resetStore({
      sessions: new Map([["s1", { backend_state: "recovering", backend_error: null }]]),
      cliConnected: new Map([["s1", false]]),
      cliEverConnected: new Map([["s1", true]]),
      cliDisconnectReason: new Map([["s1", null]]),
      sessionStatus: new Map([["s1", null]]),
    });

    const view = render(<ChatView sessionId="s1" />);
    const scope = within(view.container);
    expect(scope.getByText("Recovering session...")).toBeInTheDocument();
    expect(scope.queryByText("CLI disconnected")).not.toBeInTheDocument();
  });

  it("renders the feed without the external latest-indicator rail", () => {
    const view = render(<ChatView sessionId="s1" />);
    const scope = within(view.container);

    expect(scope.getByTestId("message-feed")).not.toHaveAttribute("data-latest-indicator-mode", "external");
    expect(scope.queryByTestId("elapsed-timer")).not.toBeInTheDocument();
  });

  it("renders a read-only preview surface without live chat controls", () => {
    const view = render(<ChatView sessionId="s1" preview />);
    const scope = within(view.container);

    expect(scope.getByText("Previewing search result. Press Enter to select this conversation.")).toBeInTheDocument();
    expect(scope.getByTestId("message-feed")).toBeInTheDocument();
    expect(scope.queryByTestId("composer")).not.toBeInTheDocument();
    expect(scope.queryByTestId("task-outline-bar")).not.toBeInTheDocument();
    expect(scope.queryByTestId("permission-banner")).not.toBeInTheDocument();
    expect(scope.queryByTestId("plan-review-overlay")).not.toBeInTheDocument();
    expect(scope.queryByTestId("todo-status-line")).not.toBeInTheDocument();
  });

  it("renders a leader thread switcher and routes selected quest thread metadata", () => {
    // q-941: leader sessions keep Main as the complete stream while exposing
    // quest-backed filtered views via an explicit thread switcher.
    resetStore({
      sessions: new Map([["s1", { backend_state: "connected", backend_error: null, isOrchestrator: true }]]),
      sdkSessions: [{ sessionId: "s1", archived: false, isOrchestrator: true }],
      messages: new Map([
        [
          "s1",
          [
            {
              id: "m1",
              role: "assistant",
              content: "q-941 update",
              timestamp: 1,
              metadata: { threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }] },
            },
          ],
        ],
      ]),
      quests: [{ questId: "q-941", title: "Quest thread MVP", status: "in_progress" }],
    });

    const view = render(<ChatView sessionId="s1" />);
    const scope = within(view.container);

    expect(scope.getByTestId("leader-thread-switcher")).toBeInTheDocument();
    expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "main");
    fireEvent.click(scope.getByRole("button", { name: /q-941/i }));
    expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-941");
    expect(scope.getByTestId("composer")).toHaveAttribute("data-thread-key", "q-941");
    expect(scope.getByTestId("composer")).toHaveAttribute("data-quest-id", "q-941");
  });

  it("offers All Threads as a global read-only projection with a return path to Main", () => {
    resetStore({
      sessions: new Map([["s1", { backend_state: "connected", backend_error: null, isOrchestrator: true }]]),
      sdkSessions: [{ sessionId: "s1", archived: false, isOrchestrator: true }],
      messages: new Map([
        [
          "s1",
          [
            { id: "m-main", role: "assistant", content: "Main update", timestamp: 1 },
            {
              id: "m-q941",
              role: "assistant",
              content: "q-941 update",
              timestamp: 2,
              metadata: { threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }] },
            },
          ],
        ],
      ]),
      quests: [{ questId: "q-941", title: "Quest thread MVP", status: "in_progress" }],
    });

    const view = render(<ChatView sessionId="s1" />);
    const scope = within(view.container);

    fireEvent.click(scope.getByTestId("leader-thread-all-row"));
    expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "all");
    expect(scope.queryByTestId("composer")).not.toBeInTheDocument();
    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-current-thread-key", "all");
    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-current-thread-label", "All Threads");

    fireEvent.click(scope.getByTestId("all-threads-return-main"));
    expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "main");
    expect(scope.getByTestId("composer")).toHaveAttribute("data-thread-key", "main");
  });

  it("materializes off-board quest threads from explicit text thread syntax", () => {
    // Explicit thread routing should reveal a selectable quest thread even
    // before the quest is present in the board/quest snapshots.
    resetStore({
      sessions: new Map([["s1", { backend_state: "connected", backend_error: null, isOrchestrator: true }]]),
      sdkSessions: [{ sessionId: "s1", archived: false, isOrchestrator: true }],
      messages: new Map([
        [
          "s1",
          [
            {
              id: "m1",
              role: "assistant",
              content: "[thread:q-958]\nI will route this in the new quest thread.",
              timestamp: 1,
            },
          ],
        ],
      ]),
      quests: [],
    });

    const view = render(<ChatView sessionId="s1" />);
    const scope = within(view.container);
    const row = scope.getByTestId("leader-thread-row");

    expect(row).toHaveAttribute("data-thread-key", "q-958");
    expect(within(row).getByRole("link", { name: "q-958" })).toBeInTheDocument();
    fireEvent.click(row);
    expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-958");
  });

  it("materializes off-board quest threads from explicit Bash command comments", () => {
    // Command comments are a separate leader-visible routing path from text
    // prefixes and should create the same selector row.
    resetStore({
      sessions: new Map([["s1", { backend_state: "connected", backend_error: null, isOrchestrator: true }]]),
      sdkSessions: [{ sessionId: "s1", archived: false, isOrchestrator: true }],
      messages: new Map([
        [
          "s1",
          [
            {
              id: "m1",
              role: "assistant",
              content: "",
              timestamp: 1,
              contentBlocks: [
                {
                  type: "tool_use",
                  id: "tool-1",
                  name: "Bash",
                  input: { command: "# thread:q-959\nquest show q-959" },
                },
              ],
            },
          ],
        ],
      ]),
      quests: [],
    });

    const view = render(<ChatView sessionId="s1" />);
    const scope = within(view.container);
    const row = scope.getByTestId("leader-thread-row");

    expect(row).toHaveAttribute("data-thread-key", "q-959");
    expect(within(row).getByRole("link", { name: "q-959" })).toBeInTheDocument();
  });

  it("does not materialize quest threads from plain quest mentions", () => {
    resetStore({
      sessions: new Map([["s1", { backend_state: "connected", backend_error: null, isOrchestrator: true }]]),
      sdkSessions: [{ sessionId: "s1", archived: false, isOrchestrator: true }],
      messages: new Map([
        [
          "s1",
          [
            {
              id: "m1",
              role: "assistant",
              content: "Please compare [q-960](quest:q-960) with q-961 before deciding.",
              timestamp: 1,
            },
          ],
        ],
      ]),
      quests: [],
    });

    const view = render(<ChatView sessionId="s1" />);
    const scope = within(view.container);

    expect(scope.getByTestId("leader-thread-switcher")).toBeInTheDocument();
    expect(scope.queryByTestId("leader-thread-row")).not.toBeInTheDocument();
    expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "main");
  });

  it("makes only the quest token a quest link and keeps title clicks routed to the thread", () => {
    resetStore({
      sessions: new Map([["s1", { backend_state: "connected", backend_error: null, isOrchestrator: true }]]),
      sdkSessions: [{ sessionId: "s1", archived: false, isOrchestrator: true }],
      messages: new Map([
        [
          "s1",
          [
            {
              id: "m1",
              role: "assistant",
              content: "q-941 update",
              timestamp: 1,
              metadata: { threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }] },
            },
            {
              id: "m2",
              role: "assistant",
              content: "q-941 follow-up",
              timestamp: 2,
              metadata: { threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }] },
            },
          ],
        ],
      ]),
      quests: [{ questId: "q-941", title: "Quest thread MVP with a longer title", status: "in_progress" }],
    });

    const view = render(<ChatView sessionId="s1" />);
    const scope = within(view.container);
    const row = scope.getByTestId("leader-thread-row");
    const questLink = within(row).getByRole("link", { name: "q-941" });

    expect(questLink).toHaveAttribute("href", "#quest-q-941");
    expect(questLink).toHaveAttribute("data-stop-propagation", "true");
    expect(within(row).getByText("Quest thread MVP with a longer title")).toBeInTheDocument();
    expect(within(row).getByTestId("leader-thread-row-stats")).toHaveTextContent("2 messages");
    expect(within(row).queryByRole("link", { name: /Quest thread MVP/i })).not.toBeInTheDocument();

    fireEvent.click(within(row).getByText("Quest thread MVP with a longer title"));
    expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-941");
  });

  it("shows compact server-board wait blockers ahead of shortened message counts", () => {
    // Thread rows should reflect the board's authoritative wait state instead of
    // inferring blockers from message content, and the blocker should remain the
    // most compact, most salient footer item.
    resetStore({
      sessions: new Map([["s1", { backend_state: "connected", backend_error: null, isOrchestrator: true }]]),
      sdkSessions: [{ sessionId: "s1", archived: false, isOrchestrator: true }],
      messages: new Map([
        [
          "s1",
          ["q-960", "q-962", "q-963", "q-964"].map((questId, index) => ({
            id: `m-${questId}`,
            role: "assistant",
            content: `${questId} update`,
            timestamp: index + 1,
            metadata: { threadRefs: [{ threadKey: questId, questId, source: "explicit" }] },
          })),
        ],
      ]),
      sessionBoards: new Map([
        [
          "s1",
          [
            {
              questId: "q-960",
              title: "Queued on quest",
              status: "QUEUED",
              waitFor: ["q-961"],
              updatedAt: 4,
              createdAt: 1,
            },
            {
              questId: "q-962",
              title: "Queued on session",
              status: "QUEUED",
              waitFor: ["#123"],
              updatedAt: 3,
              createdAt: 2,
            },
            {
              questId: "q-963",
              title: "Queued on worker capacity",
              status: "QUEUED",
              waitFor: ["free-worker"],
              updatedAt: 2,
              createdAt: 3,
            },
            {
              questId: "q-964",
              title: "Waiting on input",
              status: "IMPLEMENTING",
              waitForInput: ["n-7"],
              updatedAt: 1,
              createdAt: 4,
            },
          ],
        ],
      ]),
      quests: [
        { questId: "q-960", title: "Queued on quest", status: "in_progress" },
        { questId: "q-962", title: "Queued on session", status: "in_progress" },
        { questId: "q-963", title: "Queued on worker capacity", status: "in_progress" },
        { questId: "q-964", title: "Waiting on input", status: "in_progress" },
      ],
    });

    const view = render(<ChatView sessionId="s1" />);
    const rows = within(view.container).getAllByTestId("leader-thread-row");
    const rowByQuest = new Map(rows.map((row) => [row.getAttribute("data-thread-key"), row]));

    expect(within(rowByQuest.get("q-960")!).getByTestId("leader-thread-wait-for-chip")).toHaveTextContent("wait q-961");
    expect(within(rowByQuest.get("q-962")!).getByTestId("leader-thread-wait-for-chip")).toHaveTextContent("wait #123");
    expect(within(rowByQuest.get("q-963")!).getByTestId("leader-thread-wait-for-chip")).toHaveTextContent(
      "wait worker",
    );
    expect(within(rowByQuest.get("q-964")!).getByTestId("leader-thread-wait-for-chip")).toHaveTextContent(
      "wait input 7",
    );
    expect(within(rowByQuest.get("q-960")!).getByTestId("leader-thread-row-stats")).toHaveTextContent("1 msg");
    expect(within(view.container).getAllByTestId("leader-thread-wait-for-chip")).toHaveLength(4);
  });

  it("collapses mobile thread navigation into an overview chip and full-space selector", () => {
    // Mobile uses the same server-backed thread rows as desktop, but keeps the
    // persistent selector out of the feed until the overview chip is opened.
    resetStore({
      sessions: new Map([["s1", { backend_state: "connected", backend_error: null, isOrchestrator: true }]]),
      sdkSessions: [{ sessionId: "s1", archived: false, isOrchestrator: true }],
      messages: new Map([
        [
          "s1",
          [
            {
              id: "main",
              role: "user",
              content: "Coordinate the work board.",
              timestamp: 1,
            },
            {
              id: "active",
              role: "assistant",
              content: "active update",
              timestamp: 2,
              metadata: { threadRefs: [{ threadKey: "q-961", questId: "q-961", source: "explicit" }] },
            },
            {
              id: "queued",
              role: "assistant",
              content: "queued update",
              timestamp: 3,
              metadata: { threadRefs: [{ threadKey: "q-962", questId: "q-962", source: "explicit" }] },
            },
            {
              id: "done",
              role: "assistant",
              content: "done update",
              timestamp: 4,
              metadata: { threadRefs: [{ threadKey: "q-963", questId: "q-963", source: "explicit" }] },
            },
          ],
        ],
      ]),
      sessionBoards: new Map([
        [
          "s1",
          [
            {
              questId: "q-961",
              title: "Active thread",
              status: "IMPLEMENTING",
              updatedAt: 4,
              createdAt: 2,
            },
            {
              questId: "q-962",
              title: "Queued thread",
              status: "QUEUED",
              waitFor: ["q-961"],
              updatedAt: 3,
              createdAt: 3,
            },
          ],
        ],
      ]),
      sessionCompletedBoards: new Map([
        [
          "s1",
          [
            {
              questId: "q-963",
              title: "Done thread",
              status: "DONE",
              updatedAt: 2,
              completedAt: 2,
              createdAt: 4,
            },
          ],
        ],
      ]),
      quests: [
        { questId: "q-961", title: "Active thread", status: "in_progress" },
        { questId: "q-962", title: "Queued thread", status: "in_progress" },
        { questId: "q-963", title: "Done thread", status: "done" },
      ],
    });

    const view = render(<ChatView sessionId="s1" threadSelectorMode="mobile" />);
    const scope = within(view.container);

    expect(scope.getByTestId("leader-thread-switcher")).toHaveClass("hidden");
    expect(scope.getByTestId("mobile-thread-overview")).not.toHaveClass("sm:hidden");
    expect(scope.getByTestId("mobile-thread-overview-button")).toHaveTextContent("1 blocked");
    expect(scope.getByTestId("mobile-thread-overview-button")).toHaveTextContent("2 active");

    fireEvent.click(scope.getByTestId("mobile-thread-overview-button"));
    const sheet = scope.getByTestId("mobile-thread-selector-sheet");

    expect(sheet).toHaveClass("absolute");
    expect(sheet).toHaveTextContent("Main");
    expect(sheet).toHaveTextContent("Active");
    expect(sheet).toHaveTextContent("Queued");
    expect(sheet).toHaveTextContent("Done");
    expect(within(sheet).getByTestId("leader-thread-wait-for-chip")).toHaveTextContent("wait q-961");

    fireEvent.click(within(sheet).getByText("Queued thread"));
    expect(scope.queryByTestId("mobile-thread-selector-sheet")).not.toBeInTheDocument();
    expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-962");
    expect(scope.getByTestId("composer")).toHaveAttribute("data-quest-id", "q-962");
  });

  it("renders thread participant chips from live session status before stale board status", () => {
    // Worker/reviewer chips should match the same live session status source as
    // the sidebar, even if the board snapshot has not refreshed yet.
    resetStore({
      sessions: new Map([["s1", { backend_state: "connected", backend_error: null, isOrchestrator: true }]]),
      sdkSessions: [
        { sessionId: "s1", archived: false, isOrchestrator: true, state: "connected", cliConnected: true },
        { sessionId: "worker-running", archived: false, sessionNum: 1153, state: "connected", cliConnected: true },
        { sessionId: "reviewer-disconnected", archived: false, sessionNum: 1155, state: "exited", cliConnected: false },
        { sessionId: "worker-idle", archived: false, sessionNum: 1154, state: "connected", cliConnected: true },
      ],
      cliConnected: new Map([
        ["s1", true],
        ["worker-running", true],
        ["reviewer-disconnected", false],
        ["worker-idle", true],
      ]),
      cliDisconnectReason: new Map([
        ["s1", null],
        ["worker-running", null],
        ["reviewer-disconnected", "broken"],
        ["worker-idle", null],
      ]),
      sessionStatus: new Map([
        ["s1", "idle"],
        ["worker-running", "running"],
        ["reviewer-disconnected", null],
        ["worker-idle", "idle"],
      ]),
      messages: new Map([
        [
          "s1",
          [
            {
              id: "m-running",
              role: "assistant",
              content: "q-941 update",
              timestamp: 1,
              metadata: { threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }] },
            },
            {
              id: "m-idle",
              role: "assistant",
              content: "q-942 update",
              timestamp: 2,
              metadata: { threadRefs: [{ threadKey: "q-942", questId: "q-942", source: "explicit" }] },
            },
          ],
        ],
      ]),
      sessionBoards: new Map([
        [
          "s1",
          [
            {
              questId: "q-941",
              title: "Running thread",
              worker: "worker-running",
              workerNum: 1153,
              updatedAt: 3,
              createdAt: 1,
            },
            {
              questId: "q-942",
              title: "Idle thread",
              worker: "worker-idle",
              workerNum: 1154,
              updatedAt: 2,
              createdAt: 2,
            },
          ],
        ],
      ]),
      sessionBoardRowStatuses: new Map([
        [
          "s1",
          {
            "q-941": {
              worker: { sessionId: "worker-running", sessionNum: 1153, status: "idle" },
              reviewer: { sessionId: "reviewer-disconnected", sessionNum: 1155, status: "idle" },
            },
            "q-942": {
              worker: { sessionId: "worker-idle", sessionNum: 1154, status: "running" },
              reviewer: null,
            },
          },
        ],
      ]),
      quests: [
        { questId: "q-941", title: "Running thread", status: "in_progress" },
        { questId: "q-942", title: "Idle thread", status: "in_progress" },
      ],
    });

    const view = render(<ChatView sessionId="s1" />);
    const rows = within(view.container).getAllByTestId("leader-thread-row");
    const runningRow = rows.find((row) => row.getAttribute("data-thread-key") === "q-941")!;
    const idleRow = rows.find((row) => row.getAttribute("data-thread-key") === "q-942")!;

    expect(
      within(runningRow)
        .getAllByTestId("session-status-dot")
        .map((dot) => dot.getAttribute("data-status")),
    ).toEqual(["running", "disconnected"]);
    expect(within(idleRow).getByTestId("session-status-dot")).toHaveAttribute("data-status", "idle");
  });

  it("hides empty quest threads and separates nonempty off-board threads into Done", () => {
    resetStore({
      sessions: new Map([["s1", { backend_state: "connected", backend_error: null, isOrchestrator: true }]]),
      sdkSessions: [{ sessionId: "s1", archived: false, isOrchestrator: true }],
      messages: new Map([
        [
          "s1",
          [
            {
              id: "m-active",
              role: "assistant",
              content: "active update",
              timestamp: 200,
              metadata: { threadRefs: [{ threadKey: "q-200", questId: "q-200", source: "explicit" }] },
            },
            {
              id: "m-done",
              role: "assistant",
              content: "verification update",
              timestamp: 300,
              metadata: { threadRefs: [{ threadKey: "q-300", questId: "q-300", source: "explicit" }] },
            },
          ],
        ],
      ]),
      sessionBoards: new Map([
        [
          "s1",
          [
            {
              questId: "q-100",
              title: "Empty active thread",
              status: "IMPLEMENT",
              updatedAt: 500,
              createdAt: 100,
              journey: { mode: "active", phaseIds: ["implement"], currentPhaseIndex: 0 },
            },
            {
              questId: "q-200",
              title: "Active thread",
              status: "IMPLEMENT",
              updatedAt: 400,
              createdAt: 200,
              journey: { mode: "active", phaseIds: ["implement"], currentPhaseIndex: 0 },
            },
          ],
        ],
      ]),
      quests: [
        { questId: "q-100", title: "Empty active thread", status: "in_progress" },
        { questId: "q-200", title: "Active thread", status: "in_progress" },
        { questId: "q-300", title: "Needs verification thread", status: "needs_verification" },
      ],
    });

    const view = render(<ChatView sessionId="s1" />);
    const scope = within(view.container);
    const rows = scope.getAllByTestId("leader-thread-row");

    expect(scope.queryByText(/q-100/i)).not.toBeInTheDocument();
    expect(rows.map((row) => row.getAttribute("data-thread-key"))).toEqual(["q-200", "q-300"]);
    expect(rows.map((row) => row.getAttribute("data-thread-section"))).toEqual(["active", "done"]);
    expect(scope.getAllByText("Done").length).toBeGreaterThanOrEqual(1);
    expect(scope.queryByText("needs_verification")).not.toBeInTheDocument();
    expect(scope.queryByText("Open quest")).not.toBeInTheDocument();
  });
});
