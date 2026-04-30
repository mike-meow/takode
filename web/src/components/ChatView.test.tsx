// @vitest-environment jsdom
import { fireEvent, render, waitFor, within } from "@testing-library/react";
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
  sessionNotifications: Map<string, import("../types.js").SessionNotification[]>;
  sessionAttentionRecords: Map<string, import("../types.js").SessionAttentionRecord[]>;
  sessionBoards: Map<string, unknown[]>;
  sessionCompletedBoards: Map<string, unknown[]>;
  sessionBoardRowStatuses: Map<string, Record<string, import("../types.js").BoardRowSessionStatus>>;
  messages: Map<string, unknown[]>;
  historyLoading: Map<string, boolean>;
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
    sessionNotifications: new Map(),
    sessionAttentionRecords: new Map(),
    sessionBoards: new Map(),
    sessionCompletedBoards: new Map(),
    sessionBoardRowStatuses: new Map(),
    messages: new Map(),
    historyLoading: new Map(),
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
    onSelectThread,
  }: {
    sessionId: string;
    threadKey?: string;
    latestIndicatorMode?: string;
    onSelectThread?: (threadKey: string) => void;
  }) => (
    <div data-testid="message-feed" data-thread-key={threadKey} data-latest-indicator-mode={latestIndicatorMode}>
      {sessionId}
      {onSelectThread && (
        <button type="button" data-testid="mock-feed-thread-jump" onClick={() => onSelectThread("q-941")}>
          Jump to q-941
        </button>
      )}
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
    onSelectThread,
    openThreadKeys = [],
    onCloseThreadTab,
    threadRows = [],
    attentionRecords = [],
  }: {
    currentThreadKey?: string;
    currentThreadLabel?: string;
    onReturnToMain?: () => void;
    onSelectThread?: (threadKey: string) => void;
    openThreadKeys?: string[];
    onCloseThreadTab?: (threadKey: string) => void;
    threadRows?: Array<{ threadKey: string; questId?: string; title: string; messageCount?: number }>;
    attentionRecords?: Array<unknown>;
  }) => (
    <div
      data-testid="work-board-bar"
      data-current-thread-key={currentThreadKey}
      data-current-thread-label={currentThreadLabel}
      data-attention-count={attentionRecords.length}
      data-open-thread-keys={openThreadKeys.join(",")}
    >
      {onSelectThread && (
        <>
          <button type="button" data-testid="mock-workboard-main" onClick={() => onSelectThread("main")}>
            Main
          </button>
          <button type="button" data-testid="mock-workboard-all" onClick={() => onSelectThread("all")}>
            All Threads
          </button>
          {threadRows.map((row) => (
            <button
              type="button"
              key={row.threadKey}
              data-testid="mock-workboard-thread"
              data-thread-key={row.threadKey}
              onClick={() => onSelectThread(row.threadKey)}
            >
              {row.questId ?? row.threadKey} {row.title}
            </button>
          ))}
        </>
      )}
      {onCloseThreadTab &&
        openThreadKeys.map((threadKey) => (
          <button
            type="button"
            key={`close-${threadKey}`}
            data-testid="mock-workboard-close-tab"
            data-thread-key={threadKey}
            onClick={() => onCloseThreadTab(threadKey)}
          >
            Close {threadKey}
          </button>
        ))}
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
  QuestJourneyTimeline: ({ journey }: { journey?: { currentPhaseId?: string } }) => (
    <div data-testid="quest-journey-timeline">{journey?.currentPhaseId ?? "journey"}</div>
  ),
}));

import { ChatView } from "./ChatView.js";
import { SAVE_THREAD_VIEWPORT_EVENT } from "../utils/thread-viewport.js";

beforeEach(() => {
  resetStore();
  localStorage.clear();
  localStorage.setItem("cc-server-id", "test-server");
  window.location.hash = "#/session/s1";
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

  it("routes quest threads through the workboard without rendering the old left panel", () => {
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

    expect(scope.queryByTestId("leader-thread-switcher")).not.toBeInTheDocument();
    expect(scope.queryByTestId("mobile-thread-overview")).not.toBeInTheDocument();
    expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "main");
    expect(
      scope.getByTestId("work-board-bar").compareDocumentPosition(scope.getByTestId("message-feed")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(scope.getByRole("button", { name: /q-941 quest thread mvp/i }));
    expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-941");
    expect(window.location.hash).toBe("#/session/s1?thread=q-941");
    expect(scope.getByTestId("composer")).toHaveAttribute("data-thread-key", "q-941");
    expect(scope.getByTestId("composer")).toHaveAttribute("data-quest-id", "q-941");
    expect(scope.getByTestId("quest-thread-banner")).toHaveTextContent("Viewing quest thread");
    expect(scope.getByTestId("quest-thread-banner")).toHaveTextContent("q-941");
    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-941");
  });

  it("passes shared attention records into the top workboard navigator", () => {
    resetStore({
      sessions: new Map([["s1", { backend_state: "connected", backend_error: null, isOrchestrator: true }]]),
      sdkSessions: [{ sessionId: "s1", archived: false, isOrchestrator: true }],
      sessionAttentionRecords: new Map([
        [
          "s1",
          [
            {
              id: "attention-q941",
              leaderSessionId: "s1",
              type: "needs_input",
              source: { kind: "notification", id: "n-1", questId: "q-941" },
              questId: "q-941",
              threadKey: "q-941",
              title: "q-941 needs input",
              summary: "Answer the worker question.",
              actionLabel: "Answer",
              priority: "needs_input",
              state: "unresolved",
              createdAt: 1,
              updatedAt: 1,
              route: { threadKey: "q-941", questId: "q-941" },
              chipEligible: true,
              ledgerEligible: true,
              dedupeKey: "attention-q941",
            },
          ],
        ],
      ]),
      quests: [{ questId: "q-941", title: "Quest thread MVP", status: "in_progress" }],
    });

    const view = render(<ChatView sessionId="s1" />);
    const scope = within(view.container);

    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-attention-count", "1");
    expect(scope.getByTestId("mock-workboard-thread")).toHaveAttribute("data-thread-key", "q-941");
  });

  it("persists opened leader thread tabs locally and closes them without touching server state", () => {
    resetStore({
      sessions: new Map([["s1", { backend_state: "connected", backend_error: null, isOrchestrator: true }]]),
      sdkSessions: [{ sessionId: "s1", archived: false, isOrchestrator: true }],
      messages: new Map([
        [
          "s1",
          [
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

    fireEvent.click(scope.getByRole("button", { name: /q-941 quest thread mvp/i }));
    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-941");
    expect(localStorage.getItem("test-server:cc-leader-open-thread-tabs:s1")).toBe('["q-941"]');

    fireEvent.click(scope.getByTestId("mock-workboard-close-tab"));
    expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "main");
    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "");
    expect(localStorage.getItem("test-server:cc-leader-open-thread-tabs:s1")).toBe("[]");
  });

  it("restores persisted leader thread tabs without selecting them", () => {
    localStorage.setItem("test-server:cc-leader-open-thread-tabs:s1", '["q-941"]');
    resetStore({
      sessions: new Map([["s1", { backend_state: "connected", backend_error: null, isOrchestrator: true }]]),
      sdkSessions: [{ sessionId: "s1", archived: false, isOrchestrator: true }],
      messages: new Map([
        [
          "s1",
          [
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

    expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "main");
    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-941");
  });

  it("snapshots the current feed before switching leader threads", () => {
    // Thread navigation must save the outgoing thread viewport first so Main
    // can restore its prior reading position after visiting a quest thread.
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
    const snapshots: Array<{ sessionId?: string | null; threadKey: string | null }> = [];
    const handleSnapshot = (event: Event) => {
      snapshots.push({
        sessionId: (event as CustomEvent<{ sessionId?: string | null }>).detail?.sessionId,
        threadKey: scope.getByTestId("message-feed").getAttribute("data-thread-key"),
      });
    };
    window.addEventListener(SAVE_THREAD_VIEWPORT_EVENT, handleSnapshot);

    try {
      fireEvent.click(scope.getByRole("button", { name: /q-941 quest thread mvp/i }));
    } finally {
      window.removeEventListener(SAVE_THREAD_VIEWPORT_EVENT, handleSnapshot);
    }

    expect(snapshots).toEqual([{ sessionId: "s1", threadKey: "main" }]);
    expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-941");
  });

  it("offers All Threads as a global projection while keeping a Main/global composer available", () => {
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

    fireEvent.click(scope.getByTestId("mock-workboard-all"));
    expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "all");
    expect(window.location.hash).toBe("#/session/s1?thread=all");
    expect(scope.getByTestId("composer")).toHaveAttribute("data-thread-key", "main");
    expect(scope.getByTestId("composer")).not.toHaveAttribute("data-quest-id");
    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-current-thread-key", "all");
    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-current-thread-label", "All Threads");
    expect(scope.queryByTestId("all-threads-return-main")).not.toBeInTheDocument();

    fireEvent.click(scope.getByTestId("mock-workboard-main"));
    expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "main");
    expect(window.location.hash).toBe("#/session/s1");
    expect(scope.getByTestId("composer")).toHaveAttribute("data-thread-key", "main");
  });

  it("restores a valid leader thread from the URL route", async () => {
    resetStore({
      sessions: new Map([["s1", { backend_state: "connected", backend_error: null, isOrchestrator: true }]]),
      sdkSessions: [{ sessionId: "s1", archived: false, isOrchestrator: true }],
      messages: new Map([
        [
          "s1",
          [
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
    window.location.hash = "#/session/s1?thread=q-941";

    const view = render(<ChatView sessionId="s1" routeThreadKey="q-941" hasThreadRoute={true} />);
    const scope = within(view.container);

    await waitFor(() => {
      expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-941");
    });
    expect(scope.getByTestId("composer")).toHaveAttribute("data-thread-key", "q-941");
    expect(window.location.hash).toBe("#/session/s1?thread=q-941");
    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-941");
  });

  it("replaces an unavailable leader thread URL with Main after thread sources are loaded", async () => {
    resetStore({
      sessions: new Map([["s1", { backend_state: "connected", backend_error: null, isOrchestrator: true }]]),
      sdkSessions: [{ sessionId: "s1", archived: false, isOrchestrator: true }],
      messages: new Map([["s1", []]]),
      quests: [],
    });
    window.location.hash = "#/session/s1?thread=q-999";

    const view = render(<ChatView sessionId="s1" routeThreadKey="q-999" hasThreadRoute={true} />);
    const scope = within(view.container);

    await waitFor(() => {
      expect(window.location.hash).toBe("#/session/s1");
    });
    expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "main");
  });

  it("replaces an invalid leader thread URL with Main", async () => {
    resetStore({
      sessions: new Map([["s1", { backend_state: "connected", backend_error: null, isOrchestrator: true }]]),
      sdkSessions: [{ sessionId: "s1", archived: false, isOrchestrator: true }],
      messages: new Map([["s1", []]]),
      quests: [],
    });
    window.location.hash = "#/session/s1?thread=invalid";

    const view = render(<ChatView sessionId="s1" routeThreadKey={null} hasThreadRoute={true} />);
    const scope = within(view.container);

    await waitFor(() => {
      expect(window.location.hash).toBe("#/session/s1");
    });
    expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "main");
  });

  it("keeps preview thread jumps local without mutating the current session URL", () => {
    resetStore({
      sessions: new Map([["s2", { backend_state: "connected", backend_error: null, isOrchestrator: true }]]),
      sdkSessions: [{ sessionId: "s2", archived: false, isOrchestrator: true }],
      messages: new Map([
        [
          "s2",
          [
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
    window.location.hash = "#/session/s1";

    const view = render(<ChatView sessionId="s2" preview />);
    const scope = within(view.container);

    fireEvent.click(scope.getByTestId("mock-feed-thread-jump"));

    expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-941");
    expect(window.location.hash).toBe("#/session/s1");
  });

  it("passes off-board quest threads from explicit text routing to the workboard", () => {
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
    const row = scope.getByTestId("mock-workboard-thread");

    expect(row).toHaveAttribute("data-thread-key", "q-958");
    fireEvent.click(row);
    expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-958");
  });

  it("passes off-board quest threads from explicit Bash command comments to the workboard", () => {
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
    expect(scope.getByTestId("mock-workboard-thread")).toHaveAttribute("data-thread-key", "q-959");
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

    expect(scope.queryByTestId("mock-workboard-thread")).not.toBeInTheDocument();
    expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "main");
  });

  it("passes active and completed board rows to the workboard even before messages exist", () => {
    resetStore({
      sessions: new Map([["s1", { backend_state: "connected", backend_error: null, isOrchestrator: true }]]),
      sdkSessions: [{ sessionId: "s1", archived: false, isOrchestrator: true }],
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
              journey: { mode: "active", phaseIds: ["implement"], currentPhaseId: "implement" },
            },
          ],
        ],
      ]),
      sessionCompletedBoards: new Map([
        [
          "s1",
          [
            {
              questId: "q-200",
              title: "Completed thread",
              status: "DONE",
              updatedAt: 400,
              completedAt: 400,
              createdAt: 200,
            },
          ],
        ],
      ]),
      quests: [
        { questId: "q-100", title: "Empty active thread", status: "in_progress" },
        { questId: "q-200", title: "Completed thread", status: "done" },
      ],
    });

    const view = render(<ChatView sessionId="s1" />);
    const rows = within(view.container).getAllByTestId("mock-workboard-thread");
    expect(rows.map((row) => row.getAttribute("data-thread-key"))).toEqual(["q-100", "q-200"]);
  });

  it("shows quest Journey context in the quest-thread banner and can return to Main", () => {
    resetStore({
      sessions: new Map([["s1", { backend_state: "connected", backend_error: null, isOrchestrator: true }]]),
      sdkSessions: [{ sessionId: "s1", archived: false, isOrchestrator: true }],
      sessionBoards: new Map([
        [
          "s1",
          [
            {
              questId: "q-968",
              title: "Thread navigation rework",
              status: "IMPLEMENTING",
              updatedAt: 4,
              createdAt: 2,
              journey: {
                mode: "active",
                phaseIds: ["alignment", "implement", "code-review"],
                currentPhaseId: "implement",
              },
            },
          ],
        ],
      ]),
      quests: [{ questId: "q-968", title: "Thread navigation rework", status: "in_progress" }],
    });

    const view = render(<ChatView sessionId="s1" />);
    const scope = within(view.container);

    fireEvent.click(scope.getByRole("button", { name: /q-968 thread navigation rework/i }));
    expect(scope.getByTestId("quest-thread-banner")).toHaveTextContent("Viewing quest thread");
    expect(scope.getByTestId("quest-thread-banner")).toHaveTextContent("q-968");
    expect(scope.getByTestId("quest-thread-banner")).toHaveTextContent("Thread navigation rework");
    expect(scope.getByTestId("quest-journey-timeline")).toHaveTextContent("implement");

    fireEvent.click(scope.getByTestId("quest-thread-banner-return-main"));
    expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "main");
  });
});
