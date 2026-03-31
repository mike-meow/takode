// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { boardSummary } from "./WorkBoardBar.js";
import type { BoardRowData } from "./BoardTable.js";

// ─── boardSummary unit tests ──────────────────────────────────────────────────

describe("boardSummary", () => {
  it("returns 'Empty' for an empty board", () => {
    expect(boardSummary([])).toBe("Empty");
  });

  it("summarises a single status", () => {
    const board: BoardRowData[] = [
      { questId: "q-1", status: "IMPLEMENTING", updatedAt: 1 },
      { questId: "q-2", status: "IMPLEMENTING", updatedAt: 2 },
    ];
    expect(boardSummary(board)).toBe("2 IMPLEMENTING");
  });

  it("summarises multiple statuses", () => {
    const board: BoardRowData[] = [
      { questId: "q-1", status: "IMPLEMENTING", updatedAt: 1 },
      { questId: "q-2", status: "SKEPTIC_REVIEWING", updatedAt: 2 },
      { questId: "q-3", status: "IMPLEMENTING", updatedAt: 3 },
      { questId: "q-4", status: "PORTING", updatedAt: 4 },
    ];
    const result = boardSummary(board);
    // Order follows Map insertion order (first occurrence of each status)
    expect(result).toBe("2 IMPLEMENTING, 1 SKEPTIC_REVIEWING, 1 PORTING");
  });

  it("groups rows with missing status as 'unknown'", () => {
    const board: BoardRowData[] = [
      { questId: "q-1", updatedAt: 1 },
      { questId: "q-2", status: undefined, updatedAt: 2 },
      { questId: "q-3", status: "QUEUED", updatedAt: 3 },
    ];
    const result = boardSummary(board);
    expect(result).toBe("2 unknown, 1 QUEUED");
  });
});

// ─── WorkBoardBar component tests ─────────────────────────────────────────────

interface MockStoreState {
  sessionBoards: Map<string, BoardRowData[]>;
  sdkSessions: Array<{ sessionId: string; isOrchestrator?: boolean }>;
}

let mockState: MockStoreState;

function resetStore(overrides: Partial<MockStoreState> = {}) {
  mockState = {
    sessionBoards: new Map(),
    sdkSessions: [],
    ...overrides,
  };
}

vi.mock("../store.js", () => ({
  useStore: (selector: (s: MockStoreState) => unknown) => selector(mockState),
}));

// Mock BoardTable to avoid needing full store for QuestLink/WorkerLink
vi.mock("./BoardTable.js", () => ({
  BoardTable: ({ board }: { board: BoardRowData[] }) => (
    <div data-testid="board-table">{board.length} rows</div>
  ),
}));

// Must import after mocks are set up
const { WorkBoardBar } = await import("./WorkBoardBar.js");

beforeEach(() => {
  resetStore();
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

  it("returns null when board is empty", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", []]]),
    });
    const { container } = render(<WorkBoardBar sessionId="s1" />);
    expect(container.innerHTML).toBe("");
  });

  it("returns null when no board data exists for session", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map(),
    });
    const { container } = render(<WorkBoardBar sessionId="s1" />);
    expect(container.innerHTML).toBe("");
  });

  it("renders summary bar for orchestrator with board data", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
    });
    const { getByText } = render(<WorkBoardBar sessionId="s1" />);
    // Summary text should show status counts
    expect(getByText("1 IMPLEMENTING, 1 QUEUED")).toBeInTheDocument();
    // Item count should show total
    expect(getByText("2 items")).toBeInTheDocument();
  });

  it("does not show BoardTable when collapsed (default)", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
    });
    const { queryByTestId } = render(<WorkBoardBar sessionId="s1" />);
    expect(queryByTestId("board-table")).not.toBeInTheDocument();
  });

  it("expands to show BoardTable on click", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
    });
    const { getByRole, getByTestId } = render(<WorkBoardBar sessionId="s1" />);
    fireEvent.click(getByRole("button"));
    expect(getByTestId("board-table")).toBeInTheDocument();
  });

  it("collapses on second click", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
    });
    const { getByRole, queryByTestId } = render(<WorkBoardBar sessionId="s1" />);
    const button = getByRole("button");
    fireEvent.click(button); // expand
    fireEvent.click(button); // collapse
    expect(queryByTestId("board-table")).not.toBeInTheDocument();
  });

  it("closes on Escape key when expanded", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
    });
    const { getByRole, queryByTestId } = render(<WorkBoardBar sessionId="s1" />);
    fireEvent.click(getByRole("button")); // expand
    fireEvent.keyDown(document, { key: "Escape" });
    expect(queryByTestId("board-table")).not.toBeInTheDocument();
  });

  it("shows singular 'item' for a single board row", () => {
    const singleRow: BoardRowData[] = [
      { questId: "q-1", status: "QUEUED", updatedAt: 1 },
    ];
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", singleRow]]),
    });
    const { getByText } = render(<WorkBoardBar sessionId="s1" />);
    expect(getByText("1 item")).toBeInTheDocument();
  });
});
