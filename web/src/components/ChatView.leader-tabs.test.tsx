// @vitest-environment jsdom
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { ReactNode } from "react";
import type { LeaderOpenThreadTabsState } from "../../shared/leader-open-thread-tabs.js";

interface MockStoreState {
  pendingPermissions: Map<string, Map<string, { tool_name?: string; request_id?: string }>>;
  connectionStatus: Map<string, "connecting" | "connected" | "disconnected">;
  sessions: Map<
    string,
    {
      backend_state?: "initializing" | "resuming" | "recovering" | "connected" | "disconnected" | "broken";
      backend_error?: string | null;
      isOrchestrator?: boolean;
      leaderOpenThreadTabs?: LeaderOpenThreadTabsState;
    }
  >;
  cliConnected: Map<string, boolean>;
  cliEverConnected: Map<string, boolean>;
  cliDisconnectReason: Map<string, "idle_limit" | "broken" | null>;
  sessionStatus: Map<string, "idle" | "running" | "compacting" | "reverting" | null>;
  sdkSessions: Array<{ sessionId: string; archived?: boolean; isOrchestrator?: boolean }>;
  sessionNotifications: Map<string, import("../types.js").SessionNotification[]>;
  sessionAttentionRecords: Map<string, import("../types.js").SessionAttentionRecord[]>;
  sessionBoards: Map<string, unknown[]>;
  sessionCompletedBoards: Map<string, unknown[]>;
  sessionBoardRowStatuses: Map<string, Record<string, import("../types.js").BoardRowSessionStatus>>;
  leaderProjections: Map<string, import("../types.js").LeaderProjectionSnapshot>;
  messages: Map<string, unknown[]>;
  historyLoading: Map<string, boolean>;
  quests: Array<Record<string, unknown> & { questId: string; title: string; status: string }>;
  zoomLevel: number;
}

let mockState: MockStoreState;
const mockSendToSession = vi.fn((_sessionId: string, _msg: unknown) => true);

function resetStore(overrides: Partial<MockStoreState> = {}) {
  mockState = {
    pendingPermissions: new Map(),
    connectionStatus: new Map([["s1", "connected"]]),
    sessions: new Map([["s1", { backend_state: "connected", backend_error: null, isOrchestrator: true }]]),
    cliConnected: new Map([["s1", true]]),
    cliEverConnected: new Map([["s1", true]]),
    cliDisconnectReason: new Map([["s1", null]]),
    sessionStatus: new Map([["s1", "idle"]]),
    sdkSessions: [{ sessionId: "s1", archived: false, isOrchestrator: true }],
    sessionNotifications: new Map(),
    sessionAttentionRecords: new Map(),
    sessionBoards: new Map(),
    sessionCompletedBoards: new Map(),
    sessionBoardRowStatuses: new Map(),
    leaderProjections: new Map(),
    messages: new Map(),
    historyLoading: new Map(),
    quests: [],
    zoomLevel: 1,
    ...overrides,
  };
}

function leaderTabs(keys: string[], closed: LeaderOpenThreadTabsState["closedThreadTombstones"] = []) {
  return {
    version: 1,
    orderedOpenThreadKeys: keys,
    closedThreadTombstones: closed,
    updatedAt: 1,
  } satisfies LeaderOpenThreadTabsState;
}

function leaderSession(tabs?: LeaderOpenThreadTabsState) {
  return new Map([
    [
      "s1",
      {
        backend_state: "connected" as const,
        backend_error: null,
        isOrchestrator: true,
        ...(tabs ? { leaderOpenThreadTabs: tabs } : {}),
      },
    ],
  ]);
}

function threadMessage(questId: string, timestamp: number) {
  return {
    id: `m-${questId}`,
    role: "assistant",
    content: `${questId} update`,
    timestamp,
    metadata: { threadRefs: [{ threadKey: questId, questId, source: "explicit" }] },
  };
}

vi.mock("../store.js", () => ({
  useStore: (selector: (s: MockStoreState) => unknown) => selector(mockState),
  getSessionSearchState: () => ({ query: "", isOpen: false, mode: "strict", category: "all", matches: [] }),
}));

vi.mock("../hooks/useSessionSearch.js", () => ({ useSessionSearch: () => {} }));
vi.mock("../api.js", () => ({ api: { relaunchSession: vi.fn(), unarchiveSession: vi.fn() } }));
vi.mock("../ws.js", () => ({ sendToSession: (sessionId: string, msg: unknown) => mockSendToSession(sessionId, msg) }));
vi.mock("./SearchBar.js", () => ({ SearchBar: () => null }));
vi.mock("./TaskOutlineBar.js", () => ({ TaskOutlineBar: () => null }));
vi.mock("./TodoStatusLine.js", () => ({ TodoStatusLine: () => null }));
vi.mock("./Composer.js", () => ({
  Composer: ({ threadKey }: { threadKey?: string }) => <div data-testid="composer" data-thread-key={threadKey} />,
}));
vi.mock("./PermissionBanner.js", () => ({
  PermissionBanner: () => null,
  PlanReviewOverlay: () => null,
  PlanCollapsedChip: () => null,
  PermissionsCollapsedChip: () => null,
}));
vi.mock("./MessageFeed.js", () => ({
  MessageFeed: ({
    sessionId,
    threadKey,
    additionalAttentionRecords = [],
  }: {
    sessionId: string;
    threadKey?: string;
    additionalAttentionRecords?: Array<import("../types.js").SessionAttentionRecord>;
  }) => (
    <div
      data-testid="message-feed"
      data-thread-key={threadKey}
      data-additional-attention-count={additionalAttentionRecords.length}
    >
      {sessionId}
    </div>
  ),
}));
vi.mock("./WorkBoardBar.js", () => ({
  WorkBoardBar: ({
    currentThreadKey,
    onSelectThread,
    openThreadKeys = [],
    onCloseThreadTab,
    threadRows = [],
  }: {
    currentThreadKey?: string;
    onSelectThread?: (threadKey: string) => void;
    openThreadKeys?: string[];
    onCloseThreadTab?: (threadKey: string, nextThreadKey?: string) => void;
    threadRows?: Array<{ threadKey: string; questId?: string; title: string }>;
  }) => (
    <div
      data-testid="work-board-bar"
      data-current-thread-key={currentThreadKey}
      data-open-thread-keys={openThreadKeys.join(",")}
    >
      {onSelectThread && (
        <>
          <button type="button" data-testid="mock-workboard-main" onClick={() => onSelectThread("main")}>
            Main
          </button>
          {threadRows.map((row) => (
            <button type="button" key={row.threadKey} onClick={() => onSelectThread(row.threadKey)}>
              {row.questId ?? row.threadKey} {row.title}
            </button>
          ))}
        </>
      )}
      {onCloseThreadTab &&
        openThreadKeys.map((threadKey, index) => (
          <button
            type="button"
            key={`close-${threadKey}`}
            data-testid="mock-workboard-close-tab"
            data-thread-key={threadKey}
            onClick={() => onCloseThreadTab(threadKey, openThreadKeys[index + 1])}
          >
            Close {threadKey}
          </button>
        ))}
    </div>
  ),
}));
vi.mock("./QuestInlineLink.js", () => ({
  QuestInlineLink: ({ questId, children }: { questId: string; children?: ReactNode }) => (
    <span>{children ?? questId}</span>
  ),
}));
vi.mock("./SessionInlineLink.js", () => ({
  SessionInlineLink: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("./SessionStatusDot.js", () => ({ SessionStatusDot: () => null }));
vi.mock("./CatIcons.js", () => ({ YarnBallDot: () => null }));
vi.mock("./QuestJourneyTimeline.js", () => ({
  isCompletedJourneyPresentationStatus: () => false,
  QuestJourneyPreviewCard: () => null,
  QuestJourneyTimeline: () => null,
}));
vi.mock("./session-participant-status.js", () => ({ useParticipantSessionStatusDotProps: () => ({}) }));

import { ChatView } from "./ChatView.js";

beforeEach(() => {
  resetStore();
  localStorage.clear();
  localStorage.setItem("cc-server-id", "test-server");
  window.location.hash = "#/session/s1";
  mockSendToSession.mockClear();
});

describe("ChatView leader open thread tabs", () => {
  it("sends open and close operations to the server without writing localStorage", () => {
    resetStore({
      messages: new Map([["s1", [threadMessage("q-941", 2)]]]),
      quests: [{ questId: "q-941", title: "Quest thread MVP", status: "in_progress" }],
    });

    const view = render(<ChatView sessionId="s1" />);
    const scope = within(view.container);

    fireEvent.click(scope.getByRole("button", { name: /q-941 quest thread mvp/i }));
    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-941");
    expect(mockSendToSession).toHaveBeenCalledWith("s1", {
      type: "leader_thread_tabs_update",
      operation: { type: "open", threadKey: "q-941", placement: "first", source: "user" },
    });
    expect(localStorage.getItem("test-server:cc-leader-open-thread-tabs:s1")).toBeNull();

    fireEvent.click(scope.getByTestId("mock-workboard-close-tab"));
    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "");
    expect(mockSendToSession).toHaveBeenLastCalledWith("s1", {
      type: "leader_thread_tabs_update",
      operation: { type: "close", threadKey: "q-941", closedAt: expect.any(Number) },
    });
  });

  it("renders server-owned tabs and applies remote close updates from another browser", () => {
    resetStore({
      sessions: leaderSession(leaderTabs(["q-941", "q-777"])),
      messages: new Map([["s1", [threadMessage("q-941", 2), threadMessage("q-777", 3)]]]),
      quests: [
        { questId: "q-941", title: "Closed elsewhere", status: "in_progress" },
        { questId: "q-777", title: "Still open", status: "in_progress" },
      ],
    });

    const view = render(<ChatView sessionId="s1" />);
    const scope = within(view.container);
    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-941,q-777");

    mockState.sessions = leaderSession(leaderTabs(["q-777"], [{ threadKey: "q-941", closedAt: 10 }]));
    view.rerender(<ChatView sessionId="s1" />);

    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-777");
  });

  it("migrates valid legacy localStorage only when no server state exists", async () => {
    localStorage.setItem("test-server:cc-leader-open-thread-tabs:s1", '["q-941","q-777"]');
    resetStore({
      sessions: leaderSession(),
      messages: new Map([["s1", [threadMessage("q-941", 2), threadMessage("q-777", 3)]]]),
      quests: [
        { questId: "q-941", title: "Migrated thread", status: "in_progress" },
        { questId: "q-777", title: "Second migrated thread", status: "in_progress" },
      ],
    });

    const view = render(<ChatView sessionId="s1" />);
    const scope = within(view.container);

    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-941,q-777");
    await waitFor(() => {
      expect(mockSendToSession).toHaveBeenCalledWith("s1", {
        type: "leader_thread_tabs_update",
        operation: { type: "migrate", orderedOpenThreadKeys: ["q-941", "q-777"], migratedAt: expect.any(Number) },
      });
    });

    view.rerender(<ChatView sessionId="s1" />);
    expect(
      mockSendToSession.mock.calls.filter((call) => {
        const msg = call[1] as { operation?: { type?: string } };
        return msg.operation?.type === "migrate";
      }),
    ).toHaveLength(1);
  });

  it("ignores corrupt legacy localStorage when server state exists", async () => {
    localStorage.setItem("test-server:cc-leader-open-thread-tabs:s1", "{not-json");
    resetStore({
      sessions: leaderSession(leaderTabs(["q-server"])),
      messages: new Map([["s1", [threadMessage("q-server", 2)]]]),
      quests: [{ questId: "q-server", title: "Server tab", status: "in_progress" }],
    });

    const view = render(<ChatView sessionId="s1" />);
    const scope = within(view.container);

    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-server");
    await waitFor(() => {
      expect(localStorage.getItem("test-server:cc-leader-open-thread-tabs:s1")).toBeNull();
    });
    expect(mockSendToSession).not.toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ operation: expect.objectContaining({ type: "migrate" }) }),
    );
  });

  it("keeps leader tabs open when their quests complete or finish a Journey", () => {
    resetStore({
      sessions: leaderSession(leaderTabs(["q-941", "q-777"])),
      sessionBoards: new Map([
        [
          "s1",
          [
            { questId: "q-941", status: "IMPLEMENTING", title: "Completing tab", updatedAt: 2 },
            { questId: "q-777", status: "IMPLEMENTING", title: "Still active", updatedAt: 1 },
          ],
        ],
      ]),
      messages: new Map([["s1", [threadMessage("q-941", 2), threadMessage("q-777", 3)]]]),
      quests: [
        { questId: "q-941", title: "Completing tab", status: "in_progress" },
        { questId: "q-777", title: "Still active", status: "in_progress" },
      ],
    });

    const view = render(<ChatView sessionId="s1" />);
    const scope = within(view.container);
    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-941,q-777");

    mockState.sessionBoards = new Map([
      ["s1", [{ questId: "q-777", status: "IMPLEMENTING", title: "Still active", updatedAt: 4 }]],
    ]);
    mockState.sessionCompletedBoards = new Map([
      [
        "s1",
        [
          {
            questId: "q-941",
            status: "DONE",
            title: "Completing tab",
            updatedAt: 5,
            completedAt: 5,
            journey: { mode: "completed", phaseIds: ["alignment", "implement", "port"] },
          },
        ],
      ],
    ]);
    view.rerender(<ChatView sessionId="s1" />);

    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-941,q-777");
    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("opens fresh server-created candidates but suppresses candidates older than a user close", async () => {
    const attachedAt = Date.now();
    resetStore({
      sessions: leaderSession(leaderTabs(["q-941"], [{ threadKey: "q-1005", closedAt: attachedAt + 1 }])),
      messages: new Map([["s1", []]]),
      quests: [
        { questId: "q-941", title: "Existing thread", status: "in_progress" },
        { questId: "q-1005", title: "Closed thread", status: "in_progress" },
        { questId: "q-1006", title: "Fresh thread", status: "in_progress" },
      ],
    });

    const view = render(<ChatView sessionId="s1" />);
    const scope = within(view.container);
    mockState.messages = new Map([["s1", [movedUser("q-1005", attachedAt), movedMarker("q-1005", attachedAt)]]]);
    view.rerender(<ChatView sessionId="s1" />);

    await waitFor(() => expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "main"));
    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-941");
    expect(mockSendToSession).not.toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ operation: expect.objectContaining({ threadKey: "q-1005" }) }),
    );

    const freshAttachedAt = attachedAt + 10;
    mockState.sessions = leaderSession(leaderTabs(["q-941"], [{ threadKey: "q-1006", closedAt: freshAttachedAt - 1 }]));
    mockState.messages = new Map([
      [
        "s1",
        [
          movedUser("q-1005", attachedAt),
          movedMarker("q-1005", attachedAt),
          movedUser("q-1006", freshAttachedAt),
          movedMarker("q-1006", freshAttachedAt),
          threadMessage("q-941", freshAttachedAt + 1),
        ],
      ],
    ]);
    view.rerender(<ChatView sessionId="s1" />);

    await waitFor(() => expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-1006"));
    expect(mockSendToSession).toHaveBeenCalledWith("s1", {
      type: "leader_thread_tabs_update",
      operation: {
        type: "open",
        threadKey: "q-1006",
        placement: "first",
        source: "server_candidate",
        eventAt: freshAttachedAt,
      },
    });
  });
});

function movedUser(questId: string, attachedAt: number) {
  return {
    id: `u-${questId}`,
    role: "user",
    content: "Please make this a quest.",
    timestamp: attachedAt - 2,
    historyIndex: 1,
    metadata: { threadRefs: [{ threadKey: questId, questId, source: "backfill" }] },
  };
}

function movedMarker(questId: string, attachedAt: number) {
  return {
    id: `marker-${questId}`,
    role: "system",
    content: `1 message moved to ${questId}`,
    timestamp: attachedAt,
    historyIndex: 2,
    metadata: {
      threadAttachmentMarker: {
        type: "thread_attachment_marker",
        id: `marker-${questId}`,
        timestamp: attachedAt,
        markerKey: `thread-attachment:${questId}:u-${questId}`,
        threadKey: questId,
        questId,
        attachedAt,
        attachedBy: "leader",
        messageIds: [`u-${questId}`],
        messageIndices: [1],
        ranges: ["1"],
        count: 1,
        firstMessageId: `u-${questId}`,
        firstMessageIndex: 1,
      },
    },
  };
}
