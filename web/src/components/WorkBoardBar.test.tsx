// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { boardSummary } from "./WorkBoardBar.js";
import type { BoardRowData } from "./BoardTable.js";
import { scopedKey } from "../utils/scoped-storage.js";
import { getQuestJourneyPhaseForState } from "../../shared/quest-journey.js";
import type { SessionAttentionRecord } from "../types.js";

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
  sdkSessions: Array<{ sessionId: string; isOrchestrator?: boolean }>;
}

let mockState: MockStoreState;

function resetStore(overrides: Partial<MockStoreState> = {}) {
  mockState = {
    sessionBoards: new Map(),
    sessionBoardRowStatuses: new Map(),
    sessionCompletedBoards: new Map(),
    sdkSessions: [],
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
    expect(getByTestId("workboard-current-thread")).toHaveTextContent("Main");
    expect(getByTestId("thread-empty-state")).toHaveTextContent("No active threads");
  });

  it("keeps the primary workboard navigator visible when no board data exists for session", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map(),
    });
    const { getByText } = render(<WorkBoardBar sessionId="s1" />);
    expect(getByText("Empty")).toBeInTheDocument();
  });

  it("renders summary bar for orchestrator with board data", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
    });
    const { getByText } = render(<WorkBoardBar sessionId="s1" />);
    // Each status segment renders separately with its color class
    expect(getByText("1 Implement")).toBeInTheDocument();
    expect(getByText("1 Queued")).toBeInTheDocument();
    // Item count should show total
    expect(getByText("2 items")).toBeInTheDocument();
  });

  it("shows the current thread and can return to Main from a quest thread", () => {
    const onReturnToMain = vi.fn();
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
    });
    const { getByTestId } = render(
      <WorkBoardBar
        sessionId="s1"
        currentThreadKey="q-968"
        currentThreadLabel="q-968"
        onReturnToMain={onReturnToMain}
      />,
    );

    expect(getByTestId("workboard-current-thread")).toHaveTextContent("q-968");
    fireEvent.click(getByTestId("workboard-return-main"));
    expect(onReturnToMain).toHaveBeenCalledTimes(1);
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
    const { getAllByTestId, queryByText } = render(
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

    const chips = getAllByTestId("thread-chip");
    expect(chips.map((chip) => chip.getAttribute("data-thread-key"))).toEqual(["q-5", "q-1", "q-2"]);
    expect(chips.find((chip) => chip.getAttribute("data-thread-key") === "q-1")).toHaveAttribute(
      "data-needs-input",
      "true",
    );
    expect(chips.find((chip) => chip.getAttribute("data-thread-key") === "q-2")).toHaveAttribute(
      "data-needs-input",
      "false",
    );
    expect(queryByText("q-4 ready for review")).not.toBeInTheDocument();
    expect(queryByText("Finished work")).not.toBeInTheDocument();
  });

  it("routes thread chip clicks to the owning thread", () => {
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

    fireEvent.click(getAllByTestId("thread-chip").find((chip) => chip.getAttribute("data-thread-key") === "q-2")!);
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
