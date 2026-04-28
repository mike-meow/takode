// @vitest-environment jsdom
import { fireEvent, render, within } from "@testing-library/react";
import "@testing-library/jest-dom";

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
  sdkSessions: Array<{ sessionId: string; archived?: boolean; isOrchestrator?: boolean }>;
  sessionBoards: Map<string, unknown[]>;
  sessionCompletedBoards: Map<string, unknown[]>;
  messages: Map<string, unknown[]>;
  quests: Array<{ questId: string; title: string; status: string }>;
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
    sessionBoards: new Map(),
    sessionCompletedBoards: new Map(),
    messages: new Map(),
    quests: [],
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
  WorkBoardBar: () => <div data-testid="work-board-bar" />,
}));

vi.mock("./CatIcons.js", () => ({
  YarnBallDot: () => <span data-testid="yarnball-dot" />,
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
});
