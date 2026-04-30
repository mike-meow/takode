// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, within, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { boardSummary } from "./WorkBoardBar.js";
import type { BoardRowData } from "./BoardTable.js";
import { scopedKey } from "../utils/scoped-storage.js";
import { getQuestJourneyPhaseForState } from "../../shared/quest-journey.js";
import type { QuestmasterTask, SessionAttentionRecord, SessionState } from "../types.js";

// ─── boardSummary unit tests ──────────────────────────────────────────────────

describe("boardSummary", () => {
  it("returns 'Empty' for an empty board", () => {
    expect(boardSummary([], 0)).toEqual([{ text: "Empty", className: "text-cc-muted" }]);
  });

  it("summarises a single status with the phase metadata color", () => {
    const board: BoardRowData[] = [
      { questId: "q-1", status: "IMPLEMENTING", updatedAt: 1 },
      { questId: "q-2", status: "IMPLEMENTING", updatedAt: 2 },
    ];
    expect(boardSummary(board, 0)).toEqual([
      {
        text: "2 Implement",
        className: "text-cc-fg",
        style: { color: getQuestJourneyPhaseForState("IMPLEMENTING")?.color.accent },
      },
    ]);
  });

  it("summarises current Quest Journey phases when phase bookkeeping exists", () => {
    const board: BoardRowData[] = [
      {
        questId: "q-1",
        status: "IMPLEMENTING",
        journey: {
          presetId: "full-code",
          phaseIds: ["alignment", "implement", "code-review", "port"],
          currentPhaseId: "implement",
        },
        updatedAt: 1,
      },
    ];
    expect(boardSummary(board, 0)).toEqual([
      {
        text: "1 Implement",
        className: "text-cc-fg",
        style: { color: getQuestJourneyPhaseForState("IMPLEMENTING")?.color.accent },
      },
    ]);
  });

  it("summarises multiple statuses with distinct colors", () => {
    const board: BoardRowData[] = [
      { questId: "q-1", status: "PORTING", updatedAt: 1 },
      { questId: "q-2", status: "CODE_REVIEWING", updatedAt: 2 },
      { questId: "q-3", status: "IMPLEMENTING", updatedAt: 3 },
      { questId: "q-4", status: "IMPLEMENTING", updatedAt: 4 },
    ];
    const result = boardSummary(board, 0);
    expect(result).toEqual([
      {
        text: "1 Port",
        className: "text-cc-fg",
        style: { color: getQuestJourneyPhaseForState("PORTING")?.color.accent },
      },
      {
        text: "1 Code Review",
        className: "text-cc-fg",
        style: { color: getQuestJourneyPhaseForState("CODE_REVIEWING")?.color.accent },
      },
      {
        text: "2 Implement",
        className: "text-cc-fg",
        style: { color: getQuestJourneyPhaseForState("IMPLEMENTING")?.color.accent },
      },
    ]);
  });

  it("groups rows with missing status as 'unknown'", () => {
    const board: BoardRowData[] = [
      { questId: "q-1", updatedAt: 1 },
      { questId: "q-2", status: undefined, updatedAt: 2 },
      { questId: "q-3", status: "QUEUED", updatedAt: 3 },
    ];
    const result = boardSummary(board, 0);
    expect(result).toEqual([
      { text: "1 Queued", className: "text-cc-muted" },
      { text: "2 unknown", className: "text-cc-fg/80" },
    ]);
  });

  it("includes completed count as muted segment", () => {
    const board: BoardRowData[] = [{ questId: "q-1", status: "IMPLEMENTING", updatedAt: 1 }];
    expect(boardSummary(board, 3)).toEqual([
      {
        text: "1 Implement",
        className: "text-cc-fg",
        style: { color: getQuestJourneyPhaseForState("IMPLEMENTING")?.color.accent },
      },
      { text: "3 done", className: "text-cc-muted" },
    ]);
  });

  it("falls back to the raw status label for unknown states", () => {
    const board: BoardRowData[] = [{ questId: "q-1", status: "CUSTOM_STATUS", updatedAt: 1 }];
    expect(boardSummary(board, 0)).toEqual([{ text: "1 CUSTOM_STATUS", className: "text-cc-fg/80" }]);
  });
});

// ─── WorkBoardBar component tests ─────────────────────────────────────────────

interface MockStoreState {
  sessionBoards: Map<string, BoardRowData[]>;
  sessionBoardRowStatuses: Map<string, Record<string, import("../types.js").BoardRowSessionStatus>>;
  sessionCompletedBoards: Map<string, BoardRowData[]>;
  sdkSessions: Array<{
    sessionId: string;
    isOrchestrator?: boolean;
    sessionNum?: number;
    state?: string;
    cwd?: string;
    createdAt?: number;
  }>;
  sessions: Map<string, SessionState>;
  sessionNames: Map<string, string>;
  sessionPreviews: Map<string, string>;
  sessionTaskHistory: Map<string, unknown[]>;
  pendingPermissions: Map<string, Map<string, unknown>>;
  cliConnected: Map<string, boolean>;
  askPermission: Map<string, boolean>;
  cliDisconnectReason: Map<string, "idle_limit" | "broken" | null>;
  quests: QuestmasterTask[];
  sessionStatus: Map<string, "idle" | "running" | "compacting" | "reverting" | null>;
  activeTurnRoutes: Map<string, import("../types.js").ActiveTurnRoute | null>;
}

let mockState: MockStoreState;

function resetStore(overrides: Partial<MockStoreState> = {}) {
  mockState = {
    sessionBoards: new Map(),
    sessionBoardRowStatuses: new Map(),
    sessionCompletedBoards: new Map(),
    sdkSessions: [],
    sessions: new Map(),
    sessionNames: new Map(),
    sessionPreviews: new Map(),
    sessionTaskHistory: new Map(),
    pendingPermissions: new Map(),
    cliConnected: new Map(),
    askPermission: new Map(),
    cliDisconnectReason: new Map(),
    quests: [],
    sessionStatus: new Map(),
    activeTurnRoutes: new Map(),
    ...overrides,
  };
}

vi.mock("../store.js", () => ({
  useStore: Object.assign((selector: (s: MockStoreState) => unknown) => selector(mockState), {
    getState: () => ({
      requestScrollToMessage: vi.fn(),
      setExpandAllInTurn: vi.fn(),
    }),
  }),
  countUserPermissions: (permissions: Map<string, unknown> | undefined) => permissions?.size ?? 0,
}));

// Mock BoardTable to avoid needing full store for QuestLink/WorkerLink.
// Keep orderBoardRows real so boardSummary exercises the shared ordering logic.
vi.mock("./BoardTable.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./BoardTable.js")>();
  return {
    ...actual,
    BoardTable: ({
      board,
      mode = "active",
      onSelectQuestThread,
    }: {
      board: BoardRowData[];
      mode?: string;
      rowSessionStatuses?: unknown;
      onSelectQuestThread?: (questId: string) => void;
    }) => (
      <div data-testid="board-table" data-mode={mode}>
        {board.length} rows
        {board.map((row) => (
          <button
            key={row.questId}
            type="button"
            data-testid="board-thread-action"
            data-thread-key={row.questId.toLowerCase()}
            onClick={() => onSelectQuestThread?.(row.questId.toLowerCase())}
          >
            Jump {row.questId}
          </button>
        ))}
      </div>
    ),
  };
});

// Must import after mocks are set up
const { WorkBoardBar } = await import("./WorkBoardBar.js");

function attentionRecord(overrides: Partial<SessionAttentionRecord> = {}): SessionAttentionRecord {
  return {
    id: "attention:q-1",
    leaderSessionId: "s1",
    type: "needs_input",
    source: { kind: "notification", id: "n-1", questId: "q-1" },
    questId: "q-1",
    threadKey: "q-1",
    title: "q-1 needs input",
    summary: "Answer the implementation question.",
    actionLabel: "Answer",
    priority: "needs_input",
    state: "unresolved",
    createdAt: 100,
    updatedAt: 100,
    route: { threadKey: "q-1", questId: "q-1" },
    chipEligible: true,
    ledgerEligible: true,
    dedupeKey: "attention:q-1",
    ...overrides,
  };
}

beforeEach(() => {
  resetStore();
  localStorage.clear();
  localStorage.setItem("cc-server-id", "test-server");
});

describe("WorkBoardBar", () => {
  const BOARD_DATA: BoardRowData[] = [
    { questId: "q-1", status: "IMPLEMENTING", title: "Fix bug", updatedAt: 1 },
    { questId: "q-2", status: "QUEUED", title: "Add feature", updatedAt: 2 },
  ];

  it("returns null for non-orchestrator sessions", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: false }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
    });
    const { container } = render(<WorkBoardBar sessionId="s1" />);
    expect(container.innerHTML).toBe("");
  });

  it("keeps the primary workboard navigator visible when board is empty", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", []]]),
    });
    const { getByText, getByTestId } = render(<WorkBoardBar sessionId="s1" />);
    expect(getByText("Empty")).toBeInTheDocument();
    expect(getByTestId("workboard-main-banner")).toBeInTheDocument();
    expect(getByTestId("workboard-summary-button")).toHaveTextContent("Open Workboard");
    expect(getByTestId("thread-tab-rail")).toHaveAttribute("data-open-tab-count", "1");
    expect(getByTestId("thread-main-tab")).toHaveAttribute("data-thread-key", "main");
    expect(getByTestId("thread-main-tab")).toHaveTextContent("Main Thread");
  });

  it("keeps the primary workboard navigator visible when no board data exists for session", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map(),
    });
    const { getByText } = render(<WorkBoardBar sessionId="s1" />);
    expect(getByText("Empty")).toBeInTheDocument();
  });

  it("renders the compact Main-thread Work Board banner for orchestrators with board data", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
    });
    const { getByText, getByTestId, queryByTestId } = render(<WorkBoardBar sessionId="s1" />);
    expect(getByTestId("workboard-main-banner")).toBeInTheDocument();
    expect(queryByTestId("workboard-current-thread")).not.toBeInTheDocument();
    expect(getByTestId("workboard-summary-button")).toHaveTextContent("Open Workboard");
    // Each status segment renders separately with its color class
    expect(getByText("1 Implement")).toBeInTheDocument();
    expect(getByText("1 Queued")).toBeInTheDocument();
    // Item count should show total
    expect(getByText("2 items")).toBeInTheDocument();
    expect(
      getByTestId("thread-tab-rail").compareDocumentPosition(getByTestId("workboard-main-banner")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("hides the Work Board banner and table on quest threads while keeping the tab rail", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
    });
    localStorage.setItem(scopedKey("cc-work-board-expanded:s1"), "1");

    const { getByTestId, queryByTestId } = render(
      <WorkBoardBar sessionId="s1" currentThreadKey="q-1" currentThreadLabel="q-1" />,
    );

    expect(getByTestId("thread-tab-rail")).toBeInTheDocument();
    expect(queryByTestId("workboard-main-banner")).not.toBeInTheDocument();
    expect(queryByTestId("workboard-summary-button")).not.toBeInTheDocument();
    expect(queryByTestId("board-table")).not.toBeInTheDocument();
    expect(queryByTestId("workboard-return-main")).not.toBeInTheDocument();
  });

  it("does not show BoardTable when collapsed (default)", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
    });
    const { queryByTestId } = render(<WorkBoardBar sessionId="s1" />);
    expect(queryByTestId("board-table")).not.toBeInTheDocument();
  });

  it("renders active thread chips from board rows and active blockers", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
      sessionCompletedBoards: new Map([
        ["s1", [{ questId: "q-3", status: "DONE", title: "Finished work", updatedAt: 3, completedAt: 3 }]],
      ]),
    });
    const { getAllByTestId, getByTestId, queryByText } = render(
      <WorkBoardBar
        sessionId="s1"
        attentionRecords={[
          attentionRecord({ id: "needs-input", state: "unresolved", dedupeKey: "needs-input", title: "Answer q-1" }),
          attentionRecord({
            id: "review",
            type: "review_ready",
            priority: "review",
            actionLabel: "Review",
            route: { threadKey: "q-4", questId: "q-4" },
            threadKey: "q-4",
            questId: "q-4",
            dedupeKey: "review",
            title: "q-4 ready for review",
          }),
          attentionRecord({
            id: "reopened",
            type: "quest_reopened_or_rework",
            priority: "milestone",
            actionLabel: "Open",
            state: "reopened",
            route: { threadKey: "q-5", questId: "q-5" },
            threadKey: "q-5",
            questId: "q-5",
            dedupeKey: "reopened",
            title: "q-5 rework requested",
            updatedAt: 300,
          }),
        ]}
      />,
    );

    const tabs = getAllByTestId("thread-tab");
    expect(getByTestId("thread-tab-rail")).toHaveAttribute("data-unified-tab-track", "true");
    expect(queryByText("Active")).not.toBeInTheDocument();
    expect(tabs.map((tab) => tab.getAttribute("data-thread-key"))).toEqual(["q-5", "q-1", "q-2"]);
    expect(tabs.find((tab) => tab.getAttribute("data-thread-key") === "q-1")).toHaveAttribute(
      "data-needs-input",
      "true",
    );
    expect(tabs.find((tab) => tab.getAttribute("data-thread-key") === "q-2")).toHaveAttribute(
      "data-needs-input",
      "false",
    );
    expect(queryByText("q-4 ready for review")).not.toBeInTheDocument();
    expect(queryByText("Finished work")).not.toBeInTheDocument();
  });

  it("renders open and board-active threads on one continuous tab track", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
    });

    const { getAllByTestId, queryByText } = render(
      <WorkBoardBar
        sessionId="s1"
        openThreadKeys={["q-1"]}
        attentionRecords={[attentionRecord({ id: "needs-input", state: "unresolved", dedupeKey: "needs-input" })]}
      />,
    );

    const tabs = getAllByTestId("thread-tab");
    expect(tabs).toHaveLength(2);
    expect(tabs.map((tab) => tab.getAttribute("data-thread-key"))).toEqual(["q-1", "q-2"]);
    expect(tabs[0]).toHaveAttribute("data-needs-input", "true");
    expect(tabs[0]).toHaveAttribute("data-closable", "false");
    expect(tabs[1]).toHaveAttribute("data-closable", "false");
    expect(queryByText("Active")).not.toBeInTheDocument();
  });

  it("uses the shared quest hover card for quest thread tabs", async () => {
    resetStore({
      sdkSessions: [
        { sessionId: "s1", isOrchestrator: true },
        { sessionId: "worker-1", sessionNum: 11, state: "connected", cwd: "/repo", createdAt: 1 },
        { sessionId: "reviewer-1", sessionNum: 12, state: "connected", cwd: "/repo", createdAt: 1 },
      ],
      sessionNames: new Map([
        ["worker-1", "Worker One"],
        ["reviewer-1", "Reviewer One"],
      ]),
      quests: [
        {
          id: "q-1-v1",
          questId: "q-1",
          version: 1,
          title: "Fix tab hover preview",
          status: "in_progress",
          description: "Use one quest hover card.",
          createdAt: 1,
          sessionId: "worker-1",
          claimedAt: 1,
        },
      ],
      sessionBoards: new Map([
        [
          "s1",
          [
            {
              questId: "q-1",
              title: "Fix tab hover preview",
              status: "IMPLEMENTING",
              worker: "worker-1",
              workerNum: 11,
              updatedAt: 2,
              journey: { mode: "active", phaseIds: ["alignment", "implement", "code-review"] },
            },
          ],
        ],
      ]),
      sessionBoardRowStatuses: new Map([
        [
          "s1",
          {
            "q-1": {
              worker: { sessionId: "worker-1", sessionNum: 11, name: "Worker One", status: "running" },
              reviewer: { sessionId: "reviewer-1", sessionNum: 12, name: "Reviewer One", status: "idle" },
            },
          },
        ],
      ]),
    });

    const view = render(<WorkBoardBar sessionId="s1" />);
    const tab = view
      .getAllByTestId("thread-tab")
      .find((candidate) => candidate.getAttribute("data-thread-key") === "q-1")!;

    expect(tab).toHaveAttribute("data-has-quest-hover", "true");
    expect(tab).not.toHaveAttribute("title");
    fireEvent.mouseEnter(tab);

    const card = await view.findByTestId("quest-hover-card");
    expect(within(card).getByText("Fix tab hover preview")).toBeInTheDocument();
    expect(within(card).getByTestId("quest-journey-preview-card")).toBeInTheDocument();
    expect(within(card).getByTestId("quest-journey-timeline")).toHaveAttribute("data-journey-mode", "active");
    expect(within(card).getByTestId("quest-hover-worker-session")).toHaveTextContent("Worker");
    expect(within(card).getByTestId("quest-hover-reviewer-session")).toHaveTextContent("Reviewer");
    expect(within(card).getByText("#11")).toBeInTheDocument();
    expect(within(card).getByText("#12")).toBeInTheDocument();
  });

  it("lets off-board auto-surfaced attention tabs be dismissed from the unified track", () => {
    const onCloseThreadTab = vi.fn();
    const onSelectThread = vi.fn();
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
    });

    const { getAllByTestId, getByLabelText, queryByText } = render(
      <WorkBoardBar
        sessionId="s1"
        currentThreadKey="q-5"
        onCloseThreadTab={onCloseThreadTab}
        onSelectThread={onSelectThread}
        attentionRecords={[
          attentionRecord({
            id: "reopened",
            type: "quest_reopened_or_rework",
            priority: "milestone",
            actionLabel: "Open",
            state: "reopened",
            route: { threadKey: "q-5", questId: "q-5" },
            threadKey: "q-5",
            questId: "q-5",
            dedupeKey: "reopened",
            title: "q-5 rework requested",
            updatedAt: 300,
          }),
        ]}
      />,
    );

    const tabs = getAllByTestId("thread-tab");
    const offBoardTab = tabs.find((tab) => tab.getAttribute("data-thread-key") === "q-5")!;
    const boardActiveTab = tabs.find((tab) => tab.getAttribute("data-thread-key") === "q-1")!;
    expect(offBoardTab).toHaveAttribute("data-closable", "true");
    expect(boardActiveTab).toHaveAttribute("data-closable", "false");
    expect(within(boardActiveTab).queryByTestId("thread-tab-close")).not.toBeInTheDocument();

    fireEvent.click(getByLabelText("Close q-5"));

    expect(onCloseThreadTab).toHaveBeenCalledWith("q-5");
    expect(onSelectThread).toHaveBeenCalledWith("main");
    expect(queryByText("q-5 rework requested")).not.toBeInTheDocument();
    expect(getAllByTestId("thread-tab").map((tab) => tab.getAttribute("data-thread-key"))).toEqual(
      expect.arrayContaining(["q-1", "q-2"]),
    );
    expect(getAllByTestId("thread-tab").map((tab) => tab.getAttribute("data-thread-key"))).not.toContain("q-5");
  });

  it("colors unified board-active tab titles without rendering a separate phase label", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
    });

    const { getAllByTestId } = render(<WorkBoardBar sessionId="s1" />);

    const implementingTab = getAllByTestId("thread-tab").find((tab) => tab.getAttribute("data-thread-key") === "q-1")!;
    const implementingTitle = within(implementingTab).getByTestId("thread-tab-title");
    expect(implementingTitle).toHaveStyle({
      color: getQuestJourneyPhaseForState("IMPLEMENTING")?.color.accent,
    });
    expect(implementingTitle).toHaveTextContent("q-1");
    expect(implementingTitle).toHaveTextContent("Fix bug");
    expect(within(implementingTab).queryByText("Implement")).not.toBeInTheDocument();

    const queuedTab = getAllByTestId("thread-tab").find((tab) => tab.getAttribute("data-thread-key") === "q-2")!;
    expect(within(queuedTab).getByTestId("thread-tab-title")).toHaveAttribute("data-title-color", "var(--color-cc-fg)");
    expect(within(queuedTab).getByTestId("thread-tab-title")).not.toHaveAttribute(
      "data-title-color",
      "var(--color-cc-muted)",
    );
    expect(within(queuedTab).queryByText("Queued")).not.toBeInTheDocument();
  });

  it("shrinks open tabs like browser tabs before falling back to horizontal scrolling", () => {
    const onCloseThreadTab = vi.fn();
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", []]]),
    });

    const { getByTestId, getAllByTestId } = render(
      <WorkBoardBar
        sessionId="s1"
        currentThreadKey="q-1"
        openThreadKeys={["q-1", "q-2"]}
        onCloseThreadTab={onCloseThreadTab}
        threadRows={[
          { threadKey: "q-1", questId: "q-1", title: "Open discussion", messageCount: 2 },
          { threadKey: "q-2", questId: "q-2", title: "Older discussion", messageCount: 1 },
        ]}
      />,
    );

    expect(getByTestId("thread-tab-rail")).toHaveAttribute("data-overflow", "horizontal-scroll-after-min");
    expect(getByTestId("thread-main-tab")).toHaveAttribute("data-min-label", "Main Thread");
    expect(getByTestId("thread-main-tab")).toHaveClass("min-w-[7.75rem]", "max-w-[14rem]", "flex-[0_1_9.5rem]");
    expect(getByTestId("thread-main-tab")).toHaveClass("focus-visible:ring-cc-primary/70", "focus-visible:ring-inset");

    const tabs = getAllByTestId("thread-tab");
    expect(tabs.map((tab) => tab.getAttribute("data-min-label"))).toEqual(["q-1", "q-2"]);
    for (const tab of tabs) {
      // The fixed minimum protects the quest id; flex shrink keeps tabs browser-like until that minimum is reached.
      expect(tab).toHaveClass("min-w-[6.25rem]", "max-w-[18rem]", "flex-[1_1_11rem]");
    }
    expect(tabs[0]).toHaveClass("border-cc-primary/70", "bg-cc-bg");
    expect(within(tabs[0]).getByTestId("thread-tab-select")).toHaveClass(
      "focus-visible:ring-cc-primary/70",
      "focus-visible:ring-inset",
    );

    const selectedClose = within(tabs[0]).getByTestId("thread-tab-close");
    expect(selectedClose).toHaveAttribute("data-compact-close", "true");
    expect(selectedClose).toHaveAttribute("data-selected", "true");
    expect(selectedClose).toHaveClass("w-5", "opacity-100");

    const inactiveClose = within(tabs[1]).getByTestId("thread-tab-close");
    expect(inactiveClose).toHaveAttribute("data-compact-close", "true");
    expect(inactiveClose).toHaveAttribute("data-selected", "false");
    expect(inactiveClose).toHaveClass("w-5", "sm:opacity-0", "sm:group-hover:opacity-100", "focus-visible:opacity-100");
  });

  it("keeps selected Main as one tab surface while active output glows the title text", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", []]]),
      sessionStatus: new Map([["s1", "running"]]),
      activeTurnRoutes: new Map([["s1", { threadKey: "main" }]]),
    });

    const { getByTestId } = render(
      <WorkBoardBar
        sessionId="s1"
        currentThreadKey="main"
        attentionRecords={[
          attentionRecord({
            id: "main-needs-input",
            threadKey: "main",
            questId: undefined,
            route: { threadKey: "main" },
            title: "Main needs input",
            dedupeKey: "main-needs-input",
          }),
        ]}
      />,
    );

    const mainTab = getByTestId("thread-main-tab");
    expect(mainTab).toHaveAttribute("aria-pressed", "true");
    // The selected tab keeps the outer selected surface; the active title no longer creates a second rounded border.
    expect(mainTab).toHaveClass("border-amber-400/60", "bg-cc-bg", "focus-visible:ring-cc-primary/70");
    const mainTitle = within(mainTab).getByTestId("thread-tab-title");
    expect(mainTitle).toHaveAttribute("data-active-output", "true");
    expect(mainTitle).toHaveStyle({ animation: "thread-title-glow 2s ease-in-out infinite" });
    expect(mainTitle).not.toHaveClass("border");
    expect(mainTitle).not.toHaveClass("bg-sky-400/10");
    expect(mainTitle).not.toHaveClass("rounded");
  });

  it("does not glow selected Main without explicit active output in Main", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", []]]),
      sessionStatus: new Map([["s1", "running"]]),
      activeTurnRoutes: new Map(),
    });

    const { getByTestId } = render(<WorkBoardBar sessionId="s1" currentThreadKey="main" />);

    const mainTitle = within(getByTestId("thread-main-tab")).getByTestId("thread-tab-title");
    expect(mainTitle).toHaveAttribute("data-active-output", "false");
    expect(mainTitle).not.toHaveStyle({ animation: "thread-title-glow 2s ease-in-out infinite" });
  });

  it("marks newly added open tabs with the transient pop animation state", async () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
    });

    const view = render(<WorkBoardBar sessionId="s1" openThreadKeys={["q-1"]} />);
    expect(
      view.getAllByTestId("thread-tab").find((tab) => tab.getAttribute("data-thread-key") === "q-1"),
    ).toHaveAttribute("data-new-tab", "false");

    view.rerender(<WorkBoardBar sessionId="s1" openThreadKeys={["q-2", "q-1"]} />);

    await waitFor(() => {
      const newTab = view.getAllByTestId("thread-tab").find((tab) => tab.getAttribute("data-thread-key") === "q-2")!;
      expect(newTab).toHaveAttribute("data-new-tab", "true");
      expect(newTab).toHaveClass("thread-tab-pop");
    });
    expect(view.getAllByTestId("thread-tab").map((tab) => tab.getAttribute("data-thread-key"))).toEqual(["q-2", "q-1"]);
  });

  it("colors the whole visible quest tab title by phase without rendering a separate phase label", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
    });

    const { getAllByTestId } = render(<WorkBoardBar sessionId="s1" openThreadKeys={["q-1", "q-2"]} />);

    const implementingTab = getAllByTestId("thread-tab").find((tab) => tab.getAttribute("data-thread-key") === "q-1")!;
    const implementingTitle = within(implementingTab).getByTestId("thread-tab-title");
    expect(implementingTitle).toHaveStyle({
      color: getQuestJourneyPhaseForState("IMPLEMENTING")?.color.accent,
    });
    expect(implementingTitle).toHaveTextContent("q-1");
    expect(implementingTitle).toHaveTextContent("Fix bug");
    expect(within(implementingTab).queryByText("Implement")).not.toBeInTheDocument();

    const queuedTab = getAllByTestId("thread-tab").find((tab) => tab.getAttribute("data-thread-key") === "q-2")!;
    const queuedTitle = within(queuedTab).getByTestId("thread-tab-title");
    expect(queuedTitle).toHaveAttribute("data-title-color", "var(--color-cc-fg)");
    expect(queuedTitle).not.toHaveAttribute("data-title-color", "var(--color-cc-muted)");
    expect(within(queuedTab).queryByText("Queued")).not.toBeInTheDocument();
  });

  it("uses done gray for completed board-backed tabs instead of their final phase color", () => {
    const completed: BoardRowData[] = [
      {
        questId: "q-3",
        status: "PORTING",
        title: "Finished work",
        journey: {
          presetId: "full-code",
          phaseIds: ["alignment", "implement", "code-review", "port"],
          currentPhaseId: "port",
        },
        updatedAt: 3,
        completedAt: 3,
      },
    ];
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
      sessionCompletedBoards: new Map([["s1", completed]]),
    });

    const { getAllByTestId } = render(<WorkBoardBar sessionId="s1" currentThreadKey="q-3" openThreadKeys={["q-3"]} />);

    const completedTab = getAllByTestId("thread-tab").find((tab) => tab.getAttribute("data-thread-key") === "q-3")!;
    expect(within(completedTab).getByTestId("thread-tab-select")).toHaveAttribute("aria-pressed", "true");
    const completedTitle = within(completedTab).getByTestId("thread-tab-title");
    expect(completedTitle).toHaveAttribute("data-title-color", "var(--color-cc-muted)");
    expect(completedTitle).not.toHaveStyle({
      color: getQuestJourneyPhaseForState("PORTING")?.color.accent,
    });
  });

  it("uses done gray for off-board done thread tabs when only thread metadata is available", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
    });

    const { getAllByTestId } = render(
      <WorkBoardBar
        sessionId="s1"
        openThreadKeys={["q-99"]}
        threadRows={[
          { threadKey: "q-99", questId: "q-99", title: "Archived thread", messageCount: 1, section: "done" },
        ]}
      />,
    );

    const doneTab = getAllByTestId("thread-tab").find((tab) => tab.getAttribute("data-thread-key") === "q-99")!;
    expect(within(doneTab).getByTestId("thread-tab-title")).toHaveAttribute(
      "data-title-color",
      "var(--color-cc-muted)",
    );
  });

  it("keeps the all-quests board summary as the active phase color legend", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
    });

    const { getByTestId } = render(<WorkBoardBar sessionId="s1" />);

    const summary = getByTestId("workboard-phase-summary");
    expect(summary).toHaveTextContent("1 Implement");
    expect(summary).toHaveTextContent("1 Queued");
    expect(within(summary).getByText("1 Implement")).toHaveStyle({
      color: getQuestJourneyPhaseForState("IMPLEMENTING")?.color.accent,
    });
  });

  it("glows the active output tab title while preserving needs-input bells", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
      sessionStatus: new Map([["s1", "running"]]),
      activeTurnRoutes: new Map([["s1", { threadKey: "q-1", questId: "q-1" }]]),
    });

    const { getAllByTestId } = render(
      <WorkBoardBar
        sessionId="s1"
        currentThreadKey="q-1"
        openThreadKeys={["q-1"]}
        attentionRecords={[attentionRecord({ id: "needs-input", state: "unresolved", dedupeKey: "needs-input" })]}
      />,
    );

    const needsInputTab = getAllByTestId("thread-tab").find((tab) => tab.getAttribute("data-thread-key") === "q-1")!;
    expect(within(needsInputTab).queryByTestId("thread-tab-status-dot")).not.toBeInTheDocument();
    expect(within(needsInputTab).getByTestId("thread-tab-needs-input-bell")).toHaveAttribute(
      "data-active-output",
      "true",
    );
    expect(within(needsInputTab).getByTestId("thread-tab-needs-input-bell")).not.toHaveClass("animate-pulse");
    expect(within(needsInputTab).getByTestId("thread-tab-title")).toHaveAttribute("data-active-output", "true");
    expect(within(needsInputTab).getByTestId("thread-tab-title")).toHaveStyle({
      animation: "thread-title-glow 2s ease-in-out infinite",
    });
    expect(within(needsInputTab).getByTestId("thread-tab-title")).not.toHaveClass("border");
    expect(within(needsInputTab).getByTestId("thread-tab-title")).not.toHaveClass("bg-sky-400/10");

    const inactiveTitle = getAllByTestId("thread-tab-title").find(
      (title) => title.closest("[data-thread-key]")?.getAttribute("data-thread-key") === "q-2",
    );
    expect(inactiveTitle).toBeTruthy();
    expect(inactiveTitle).toHaveAttribute("data-active-output", "false");
    expect(inactiveTitle).not.toHaveStyle({ animation: "thread-title-glow 2s ease-in-out infinite" });
  });

  it("embeds Main-owned needs-input state into the pinned Main tab without a duplicate chip", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", []]]),
    });

    const { getByTestId, queryByTestId } = render(
      <WorkBoardBar
        sessionId="s1"
        attentionRecords={[
          attentionRecord({
            id: "main-needs-input",
            threadKey: "main",
            questId: undefined,
            route: { threadKey: "main" },
            title: "Main needs input",
            dedupeKey: "main-needs-input",
          }),
        ]}
      />,
    );

    expect(getByTestId("thread-main-tab")).toHaveAttribute("data-needs-input", "true");
    expect(getByTestId("thread-main-tab")).toHaveTextContent("Answer");
    expect(queryByTestId("thread-chip")).not.toBeInTheDocument();
    expect(getByTestId("thread-tab-rail")).toHaveAttribute("data-closed-chip-count", "0");
  });

  it("keeps closed inactive history hidden unless the user has opened it as a tab", () => {
    const completed = [{ questId: "q-3", status: "DONE", title: "Finished work", updatedAt: 3, completedAt: 3 }];
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
      sessionCompletedBoards: new Map([["s1", completed]]),
    });

    const { queryByText, queryByTestId, rerender, getAllByTestId } = render(
      <WorkBoardBar
        sessionId="s1"
        threadRows={[{ threadKey: "q-3", questId: "q-3", title: "Finished work", messageCount: 2, section: "done" }]}
      />,
    );

    expect(queryByText("Finished work")).not.toBeInTheDocument();

    rerender(
      <WorkBoardBar
        sessionId="s1"
        openThreadKeys={["q-3"]}
        threadRows={[{ threadKey: "q-3", questId: "q-3", title: "Finished work", messageCount: 2, section: "done" }]}
      />,
    );

    expect(getAllByTestId("thread-tab").find((tab) => tab.getAttribute("data-thread-key") === "q-3")).toHaveTextContent(
      "Finished work",
    );
    expect(queryByTestId("thread-chip")).not.toBeInTheDocument();
  });

  it("keeps Main pinned and only exposes close controls for closable thread tabs", () => {
    const onCloseThreadTab = vi.fn();
    const completed = [{ questId: "q-3", status: "DONE", title: "Finished work", updatedAt: 3, completedAt: 3 }];
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
      sessionCompletedBoards: new Map([["s1", completed]]),
    });

    const { getAllByTestId, getByTestId, getByLabelText, queryByLabelText } = render(
      <WorkBoardBar sessionId="s1" openThreadKeys={["q-1", "q-3"]} onCloseThreadTab={onCloseThreadTab} />,
    );

    expect(getByTestId("thread-main-tab")).toHaveTextContent("Main Thread");
    expect(queryByLabelText("Close Main")).not.toBeInTheDocument();
    const activeTab = getAllByTestId("thread-tab").find((tab) => tab.getAttribute("data-thread-key") === "q-1")!;
    const completedTab = getAllByTestId("thread-tab").find((tab) => tab.getAttribute("data-thread-key") === "q-3")!;
    expect(activeTab).toHaveAttribute("data-closable", "false");
    expect(completedTab).toHaveAttribute("data-closable", "true");
    expect(within(activeTab).queryByTestId("thread-tab-close")).not.toBeInTheDocument();
    fireEvent.click(getByLabelText("Close q-3"));
    expect(onCloseThreadTab).toHaveBeenCalledWith("q-3");
  });

  it("uses sibling select and close buttons for open tabs", () => {
    const onSelectThread = vi.fn();
    const onCloseThreadTab = vi.fn();
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
    });

    const { getAllByTestId, getByLabelText } = render(
      <WorkBoardBar
        sessionId="s1"
        openThreadKeys={["q-99"]}
        onSelectThread={onSelectThread}
        onCloseThreadTab={onCloseThreadTab}
        threadRows={[{ threadKey: "q-99", questId: "q-99", title: "Off-board thread", messageCount: 2 }]}
      />,
    );

    const tab = getAllByTestId("thread-tab").find((candidate) => candidate.getAttribute("data-thread-key") === "q-99")!;
    expect(tab.tagName).toBe("DIV");
    expect(tab.querySelector("button button")).toBeNull();

    fireEvent.click(within(tab).getByTestId("thread-tab-select"));
    expect(onSelectThread).toHaveBeenCalledWith("q-99");

    fireEvent.click(getByLabelText("Close q-99"));
    expect(onCloseThreadTab).toHaveBeenCalledWith("q-99");
  });

  it("routes unified active tab clicks to the owning thread", () => {
    const onSelectThread = vi.fn();
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
    });
    const { getAllByTestId } = render(
      <WorkBoardBar
        sessionId="s1"
        currentThreadKey="main"
        onSelectThread={onSelectThread}
        attentionRecords={[attentionRecord({ route: { threadKey: "q-2", questId: "q-2" }, threadKey: "q-2" })]}
      />,
    );

    fireEvent.click(
      within(getAllByTestId("thread-tab").find((tab) => tab.getAttribute("data-thread-key") === "q-2")!).getByTestId(
        "thread-tab-select",
      ),
    );
    expect(onSelectThread).toHaveBeenCalledWith("q-2");
  });

  it("expands to show BoardTable on click", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
    });
    const { getByTestId } = render(<WorkBoardBar sessionId="s1" />);
    fireEvent.click(getByTestId("workboard-summary-button"));
    expect(getByTestId("board-table")).toBeInTheDocument();
    expect(
      getByTestId("workboard-summary-button").compareDocumentPosition(getByTestId("board-table")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      getByTestId("thread-tab-rail").compareDocumentPosition(getByTestId("workboard-main-banner")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      getByTestId("workboard-main-banner").compareDocumentPosition(getByTestId("board-table")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("collapses on second click", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
    });
    const { getByTestId, queryByTestId } = render(<WorkBoardBar sessionId="s1" />);
    const button = getByTestId("workboard-summary-button");
    fireEvent.click(button); // expand
    fireEvent.click(button); // collapse
    expect(queryByTestId("board-table")).not.toBeInTheDocument();
  });

  it("closes on Escape key when expanded", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
    });
    const { getByTestId, queryByTestId } = render(<WorkBoardBar sessionId="s1" />);
    fireEvent.click(getByTestId("workboard-summary-button")); // expand
    fireEvent.keyDown(document, { key: "Escape" });
    expect(queryByTestId("board-table")).not.toBeInTheDocument();
  });

  it("shows singular 'item' for a single board row", () => {
    const singleRow: BoardRowData[] = [{ questId: "q-1", status: "QUEUED", updatedAt: 1 }];
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", singleRow]]),
    });
    const { getByText } = render(<WorkBoardBar sessionId="s1" />);
    expect(getByText("1 item")).toBeInTheDocument();
  });

  it("persists expanded state per session across remounts and session switches", () => {
    resetStore({
      sdkSessions: [
        { sessionId: "s1", isOrchestrator: true },
        { sessionId: "s2", isOrchestrator: true },
      ],
      sessionBoards: new Map([
        ["s1", BOARD_DATA],
        ["s2", BOARD_DATA],
      ]),
    });
    const { getByTestId, queryByTestId, rerender, unmount } = render(<WorkBoardBar sessionId="s1" />);

    fireEvent.click(getByTestId("workboard-summary-button"));
    expect(getByTestId("board-table")).toBeInTheDocument();
    expect(localStorage.getItem(scopedKey("cc-work-board-expanded:s1"))).toBe("1");

    rerender(<WorkBoardBar sessionId="s2" />);
    expect(queryByTestId("board-table")).not.toBeInTheDocument();

    rerender(<WorkBoardBar sessionId="s1" currentThreadKey="q-1" />);
    expect(queryByTestId("workboard-main-banner")).not.toBeInTheDocument();
    expect(queryByTestId("board-table")).not.toBeInTheDocument();

    rerender(<WorkBoardBar sessionId="s1" />);
    expect(getByTestId("board-table")).toBeInTheDocument();

    unmount();
    const remounted = render(<WorkBoardBar sessionId="s1" />);
    expect(remounted.getByTestId("board-table")).toBeInTheDocument();
  });

  it("does not collapse on outside click", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
    });
    const { getByTestId } = render(<WorkBoardBar sessionId="s1" />);
    fireEvent.click(getByTestId("workboard-summary-button"));
    expect(getByTestId("board-table")).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(getByTestId("board-table")).toBeInTheDocument();
  });

  it("offers Main and All Threads navigation when expanded", () => {
    const onSelectThread = vi.fn();
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
    });

    const { getByTestId } = render(<WorkBoardBar sessionId="s1" onSelectThread={onSelectThread} />);
    fireEvent.click(getByTestId("workboard-summary-button"));
    expect(getByTestId("workboard-thread-main")).toHaveAttribute("data-variant", "compact");
    expect(getByTestId("workboard-thread-main")).toHaveAttribute("data-secondary", "false");
    expect(getByTestId("workboard-thread-all")).toHaveAttribute("data-variant", "compact");
    expect(getByTestId("workboard-thread-all")).toHaveAttribute("data-secondary", "true");
    fireEvent.click(getByTestId("workboard-thread-main"));
    fireEvent.click(getByTestId("workboard-thread-all"));

    expect(onSelectThread).toHaveBeenNthCalledWith(1, "main");
    expect(onSelectThread).toHaveBeenNthCalledWith(2, "all");
  });

  it("navigates active and completed quest threads without changing QuestLink semantics", () => {
    const onSelectThread = vi.fn();
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
      sessionCompletedBoards: new Map([
        ["s1", [{ questId: "q-3", status: "DONE", title: "Finished", updatedAt: 3, completedAt: 3 }]],
      ]),
    });

    const { getByTestId, getAllByTestId, getByText } = render(
      <WorkBoardBar sessionId="s1" onSelectThread={onSelectThread} />,
    );
    fireEvent.click(getByTestId("workboard-summary-button"));
    fireEvent.click(getAllByTestId("board-thread-action")[0]);
    fireEvent.click(getByText("1 completed"));
    fireEvent.click(getAllByTestId("board-thread-action").find((button) => button.textContent?.includes("q-3"))!);

    expect(onSelectThread).toHaveBeenNthCalledWith(1, "q-1");
    expect(onSelectThread).toHaveBeenNthCalledWith(2, "q-3");
  });

  it("navigates off-board quest threads from thread metadata", () => {
    const onSelectThread = vi.fn();
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
    });

    const { getByTestId } = render(
      <WorkBoardBar
        sessionId="s1"
        onSelectThread={onSelectThread}
        threadRows={[{ threadKey: "q-99", questId: "q-99", title: "Off-board thread", messageCount: 2 }]}
      />,
    );

    fireEvent.click(getByTestId("workboard-summary-button"));
    expect(getByTestId("workboard-off-board-threads")).toHaveTextContent("Off-board thread");
    fireEvent.click(getByTestId("workboard-off-board-thread"));
    expect(onSelectThread).toHaveBeenCalledWith("q-99");
  });

  it("filters expanded board and off-board history lookup by query", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
    });

    const { getByLabelText, getByTestId, queryByText } = render(
      <WorkBoardBar
        sessionId="s1"
        onSelectThread={vi.fn()}
        threadRows={[{ threadKey: "q-99", questId: "q-99", title: "Archived follow-up thread", messageCount: 2 }]}
      />,
    );

    fireEvent.click(getByTestId("workboard-summary-button"));
    fireEvent.change(getByLabelText("Search threads, board, and history"), { target: { value: "archived" } });

    expect(getByTestId("workboard-off-board-threads")).toHaveTextContent("Archived follow-up thread");
    expect(queryByText("No active items match")).toBeInTheDocument();
  });
});
