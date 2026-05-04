// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, within, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { boardSummary, reorderThreadTabsAfterDrag } from "./WorkBoardBar.js";
import type { BoardRowData } from "./BoardTable.js";
import { scopedKey } from "../utils/scoped-storage.js";
import { getQuestJourneyPhaseForState } from "../../shared/quest-journey.js";
import type { QuestJourneyPhaseId } from "../../shared/quest-journey.js";
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

describe("reorderThreadTabsAfterDrag", () => {
  it("reorders sortable thread keys and ignores Main or unknown drag targets", () => {
    expect(reorderThreadTabsAfterDrag(["q-1", "q-2", "q-3"], "q-3", "q-1")).toEqual(["q-3", "q-1", "q-2"]);
    expect(reorderThreadTabsAfterDrag(["q-1", "q-2"], "main", "q-2")).toEqual(["q-1", "q-2"]);
    expect(reorderThreadTabsAfterDrag(["q-1", "q-2"], "q-1", "q-missing")).toEqual(["q-1", "q-2"]);
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

function expectStripeOriginActiveOutputMarker(container: HTMLElement) {
  const marker = within(container).getByTestId("thread-tab-active-output-indicator");
  expect(marker).toHaveAttribute("data-reduced-motion-static", "true");
  expect(marker).toHaveAttribute("data-dot-position", "stripe-origin");
  expect(marker).toHaveAttribute("data-stripe-origin", "top-left");
  expect(marker).not.toHaveAttribute("data-dot-lane");
  expect(marker).not.toHaveAttribute("data-overlaps-needs-input");
  expect(marker).not.toHaveAttribute("data-bell-center-offset");
  expect(marker).not.toHaveAttribute("data-halo-center-offset");
  expect(marker).toHaveClass("inset-0");
  expect(marker).not.toHaveClass("inset-x-1");

  const glintTrack = within(marker).getByTestId("thread-tab-active-output-glint-track");
  expect(glintTrack).toHaveClass("inset-x-1", "top-0", "h-px");
  const glint = within(marker).getByTestId("thread-tab-active-output-glint");
  expect(glint).toHaveClass("thread-tab-output-glint");
  const dot = within(marker).getByTestId("thread-tab-active-output-dot");
  expect(dot).toHaveClass("left-1", "top-0", "h-2", "w-2", "-translate-x-1/2", "-translate-y-1/2", "bg-sky-50/95");
  return { marker, glintTrack, glint, dot };
}

beforeEach(() => {
  resetStore();
  localStorage.clear();
  localStorage.setItem("cc-server-id", "test-server");
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
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
    expect(
      getByTestId("workboard-summary-button").compareDocumentPosition(getByTestId("workboard-phase-summary")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
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

  it("clamps repeated-phase Journey previews in quest thread-tab hovers", async () => {
    const phaseIds: QuestJourneyPhaseId[] = [
      "alignment",
      "implement",
      "code-review",
      "execute",
      "implement",
      "code-review",
      "execute",
      "implement",
      "code-review",
      "execute",
      "implement",
      "code-review",
      "execute",
    ];
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      quests: [
        {
          id: "q-1134-v1",
          questId: "q-1134",
          version: 1,
          title: "Try repeated Journey preview",
          status: "in_progress",
          description: "Repeated phases near the end should still clamp in tab hover previews.",
          createdAt: 1,
          sessionId: "worker-1134",
          claimedAt: 1,
        },
      ],
      sessionBoards: new Map([
        [
          "s1",
          [
            {
              questId: "q-1134",
              title: "Try repeated Journey preview",
              status: "CODE_REVIEWING",
              updatedAt: 2,
              journey: {
                mode: "active",
                phaseIds,
                currentPhaseId: "code-review",
                activePhaseIndex: 11,
                phaseNotes: {
                  "5": "Sixth previous phase hidden by default.",
                  "6": "First visible previous phase.",
                  "11": "Current repeated review phase.",
                },
              },
            },
          ],
        ],
      ]),
    });

    const view = render(<WorkBoardBar sessionId="s1" openThreadKeys={["q-1134"]} />);
    const tab = view
      .getAllByTestId("thread-tab")
      .find((candidate) => candidate.getAttribute("data-thread-key") === "q-1134")!;

    fireEvent.mouseEnter(tab);

    const card = await view.findByTestId("quest-hover-card");
    const journey = within(card).getByTestId("quest-hover-journey");
    const visibleIndexes = Array.from(journey.querySelectorAll("li[data-phase-index]")).map((row) =>
      Number(row.getAttribute("data-phase-index")),
    );
    expect(visibleIndexes).toEqual([6, 7, 8, 9, 10, 11, 12]);
    expect(journey.querySelector('li[data-phase-index="11"]')).toHaveAttribute("data-phase-current", "true");
    expect(within(journey).queryByText("Sixth previous phase hidden by default.")).not.toBeInTheDocument();
    expect(within(journey).getByText("First visible previous phase.")).toBeInTheDocument();
    expect(within(journey).getByRole("button", { name: "Show 6 earlier phases" })).toBeInTheDocument();

    fireEvent.click(within(journey).getByRole("button", { name: "Show 6 earlier phases" }));
    expect(within(journey).getByText("Sixth previous phase hidden by default.")).toBeInTheDocument();
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
    const expectedNextThread = tabs[tabs.indexOf(offBoardTab) + 1]?.getAttribute("data-thread-key") ?? "main";
    const boardActiveTab = tabs.find((tab) => tab.getAttribute("data-thread-key") === "q-1")!;
    expect(offBoardTab).toHaveAttribute("data-closable", "true");
    expect(boardActiveTab).toHaveAttribute("data-closable", "false");
    expect(within(boardActiveTab).queryByTestId("thread-tab-close")).not.toBeInTheDocument();

    fireEvent.click(getByLabelText("Close q-5"));

    expect(onCloseThreadTab).toHaveBeenCalledWith("q-5", expectedNextThread);
    expect(onSelectThread).toHaveBeenCalledWith(expectedNextThread);
    expect(queryByText("q-5 rework requested")).not.toBeInTheDocument();
    expect(getAllByTestId("thread-tab").map((tab) => tab.getAttribute("data-thread-key"))).toEqual(
      expect.arrayContaining(["q-1", "q-2"]),
    );
    expect(getAllByTestId("thread-tab").map((tab) => tab.getAttribute("data-thread-key"))).not.toContain("q-5");
  });

  it("uses canonical quest titles for open tabs and keeps closed attention tabs from reappearing", () => {
    const onCloseThreadTab = vi.fn();
    const staleReworkRecord = attentionRecord({
      id: "reopened-q-1066",
      type: "quest_reopened_or_rework",
      priority: "milestone",
      actionLabel: "Open",
      state: "reopened",
      route: { threadKey: "q-1066", questId: "q-1066" },
      threadKey: "q-1066",
      questId: "q-1066",
      dedupeKey: "reopened-q-1066",
      title: "q-1066: rework requested",
      updatedAt: 300,
    });
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", []]]),
      quests: [
        {
          id: "q-1066-v1",
          questId: "q-1066",
          version: 1,
          title: "Keep Codex tool-router errors from stranding sessions",
          status: "done",
          description: "Router failures should not strand sessions.",
          createdAt: 1,
          completedAt: 2,
          verificationItems: [],
        },
      ],
    });

    const view = render(
      <WorkBoardBar
        sessionId="s1"
        openThreadKeys={["q-1066", "q-1119"]}
        onCloseThreadTab={onCloseThreadTab}
        attentionRecords={[staleReworkRecord]}
        threadRows={[{ threadKey: "q-1119", questId: "q-1119", title: "Recovery follow-up", messageCount: 1 }]}
      />,
    );

    const q1066Tab = view.getAllByTestId("thread-tab").find((tab) => tab.getAttribute("data-thread-key") === "q-1066")!;
    expect(q1066Tab).toHaveTextContent("q-1066");
    expect(q1066Tab).toHaveTextContent("Keep Codex tool-router errors from stranding sessions");
    expect(q1066Tab).not.toHaveTextContent("rework requested");

    fireEvent.click(view.getByLabelText("Close q-1066"));
    expect(onCloseThreadTab).toHaveBeenCalledWith("q-1066", "q-1119");

    view.rerender(
      <WorkBoardBar
        sessionId="s1"
        openThreadKeys={["q-1119"]}
        onCloseThreadTab={onCloseThreadTab}
        attentionRecords={[staleReworkRecord]}
        threadRows={[{ threadKey: "q-1119", questId: "q-1119", title: "Recovery follow-up", messageCount: 1 }]}
      />,
    );

    expect(view.getAllByTestId("thread-tab").map((tab) => tab.getAttribute("data-thread-key"))).toEqual(["q-1119"]);
    expect(view.queryByText("q-1066: rework requested")).not.toBeInTheDocument();
  });

  it("suppresses remotely closed auto attention tabs while attention remains active", async () => {
    const staleReworkRecord = attentionRecord({
      id: "remote-reopened-q-1066",
      type: "quest_reopened_or_rework",
      priority: "milestone",
      actionLabel: "Open",
      state: "reopened",
      route: { threadKey: "q-1066", questId: "q-1066" },
      threadKey: "q-1066",
      questId: "q-1066",
      dedupeKey: "remote-reopened-q-1066",
      title: "q-1066: rework requested",
      updatedAt: 300,
    });
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", []]]),
      quests: [
        {
          id: "q-1066-v1",
          questId: "q-1066",
          version: 1,
          title: "Keep Codex tool-router errors from stranding sessions",
          status: "done",
          description: "Router failures should not strand sessions.",
          createdAt: 1,
          completedAt: 2,
          verificationItems: [],
        },
      ],
    });

    const view = render(
      <WorkBoardBar
        sessionId="s1"
        openThreadKeys={["q-1066", "q-1119"]}
        attentionRecords={[staleReworkRecord]}
        threadRows={[{ threadKey: "q-1119", questId: "q-1119", title: "Recovery follow-up", messageCount: 1 }]}
      />,
    );

    expect(view.getAllByTestId("thread-tab").map((tab) => tab.getAttribute("data-thread-key"))).toEqual([
      "q-1066",
      "q-1119",
    ]);

    view.rerender(
      <WorkBoardBar
        sessionId="s1"
        openThreadKeys={["q-1119"]}
        closedThreadKeys={["q-1066"]}
        attentionRecords={[staleReworkRecord]}
        threadRows={[{ threadKey: "q-1119", questId: "q-1119", title: "Recovery follow-up", messageCount: 1 }]}
      />,
    );

    await waitFor(() => {
      expect(view.getAllByTestId("thread-tab").map((tab) => tab.getAttribute("data-thread-key"))).toEqual(["q-1119"]);
    });
    expect(view.queryByText("q-1066: rework requested")).not.toBeInTheDocument();
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
    expect(within(getByTestId("thread-tab-rail")).queryByText("Tabs")).not.toBeInTheDocument();
    const tabStrip = getByTestId("thread-tab-strip");
    expect(tabStrip).toHaveAttribute("aria-label", "Thread tabs");
    expect(tabStrip).toHaveAttribute("data-scrollbar", "thin-transient");
    expect(tabStrip).toHaveAttribute("data-scrollbar-active", "false");
    expect(tabStrip).toHaveClass("overflow-x-auto", "overflow-y-hidden", "thread-tab-scroll");
    fireEvent.scroll(tabStrip);
    expect(tabStrip).toHaveAttribute("data-scrollbar-active", "true");
    expect(getByTestId("thread-main-tab")).toHaveAttribute("data-min-label", "Main Thread");
    expect(getByTestId("thread-main-tab")).toHaveClass("min-w-[7.75rem]", "max-w-[14rem]", "flex-[0_1_9.5rem]");
    expect(getByTestId("thread-main-tab")).toHaveClass("focus-visible:ring-violet-100/70", "focus-visible:ring-inset");

    const tabs = getAllByTestId("thread-tab");
    expect(tabs.map((tab) => tab.getAttribute("data-min-label"))).toEqual(["q-1", "q-2"]);
    for (const tab of tabs) {
      // The fixed minimum protects the quest id; flex shrink keeps tabs browser-like until that minimum is reached.
      expect(tab).toHaveClass("min-w-[6.25rem]", "max-w-[18rem]", "flex-[1_1_11rem]");
    }
    expect(tabs[0]).toHaveClass("border-violet-100/45", "border-b-transparent", "text-white");
    expect(within(tabs[0]).getByTestId("thread-tab-select")).toHaveClass(
      "focus-visible:ring-violet-100/70",
      "focus-visible:ring-inset",
    );

    const selectedClose = within(tabs[0]).getByTestId("thread-tab-close");
    expect(selectedClose).toHaveAttribute("data-compact-close", "true");
    expect(selectedClose).toHaveAttribute("data-selected", "true");
    expect(selectedClose).toHaveClass("w-5", "opacity-100");
    expect(selectedClose).not.toHaveClass("sm:w-0");

    const inactiveClose = within(tabs[1]).getByTestId("thread-tab-close");
    expect(inactiveClose).toHaveAttribute("data-compact-close", "true");
    expect(inactiveClose).toHaveAttribute("data-selected", "false");
    expect(inactiveClose).toHaveClass(
      "w-5",
      "sm:w-0",
      "sm:border-l-0",
      "sm:opacity-0",
      "sm:group-hover:w-5",
      "sm:group-hover:border-l",
      "sm:group-hover:opacity-100",
      "focus-visible:w-5",
      "focus-visible:border-l",
      "focus-visible:opacity-100",
    );
  });

  it("keeps selected Main as one connected surface while active output uses a separate marker", () => {
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
    expect(mainTab).toHaveAttribute("data-active-output", "true");
    expect(mainTab).toHaveClass("border-violet-100/45", "border-b-transparent", "text-white");
    expect(mainTab).toHaveClass("bg-white/[0.055]");
    expect(mainTab.className).not.toContain("rgba(139,92,246");
    expect(mainTab).toHaveClass("focus-visible:ring-violet-100/70");
    expect(mainTab).not.toHaveClass("border-amber-400/60", "border-cc-primary/70", "border-b-cc-bg");
    expectStripeOriginActiveOutputMarker(mainTab);
    expect(within(mainTab).getByTestId("thread-tab-needs-input-bell")).toHaveClass("relative", "z-10");
    const mainTitle = within(mainTab).getByTestId("thread-tab-title");
    expect(mainTitle).toHaveAttribute("data-active-output", "true");
    expect(mainTitle.getAttribute("style") ?? "").not.toContain("animation");
    expect(mainTitle).not.toHaveClass("border");
    expect(mainTitle).not.toHaveClass("bg-sky-400/10");
    expect(mainTitle).not.toHaveClass("text-sky-100");
    expect(mainTitle).not.toHaveClass("rounded");
  });

  it("does not render an active output marker on selected Main without explicit active output in Main", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", []]]),
      sessionStatus: new Map([["s1", "running"]]),
      activeTurnRoutes: new Map(),
    });

    const { getByTestId } = render(<WorkBoardBar sessionId="s1" currentThreadKey="main" />);

    const mainTab = getByTestId("thread-main-tab");
    expect(mainTab).toHaveAttribute("data-active-output", "false");
    expect(within(mainTab).queryByTestId("thread-tab-active-output-indicator")).not.toBeInTheDocument();
    const mainTitle = within(mainTab).getByTestId("thread-tab-title");
    expect(mainTitle).toHaveAttribute("data-active-output", "false");
    expect(mainTitle.getAttribute("style") ?? "").not.toContain("animation");
  });

  it("composes selected and active-output states when they are on different tabs", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
      sessionStatus: new Map([["s1", "running"]]),
      activeTurnRoutes: new Map([["s1", { threadKey: "q-1", questId: "q-1" }]]),
    });

    const { getAllByTestId } = render(
      <WorkBoardBar sessionId="s1" currentThreadKey="q-2" openThreadKeys={["q-1", "q-2"]} />,
    );

    const activeTab = getAllByTestId("thread-tab").find((tab) => tab.getAttribute("data-thread-key") === "q-1")!;
    expect(within(activeTab).getByTestId("thread-tab-select")).toHaveAttribute("aria-pressed", "false");
    expect(activeTab).toHaveAttribute("data-active-output", "true");
    expect(within(activeTab).getByTestId("thread-tab-active-output-indicator")).toBeInTheDocument();
    expect(within(activeTab).getByTestId("thread-tab-title")).toHaveStyle({
      color: getQuestJourneyPhaseForState("IMPLEMENTING")?.color.accent,
    });
    expect(within(activeTab).getByTestId("thread-tab-title").getAttribute("style") ?? "").not.toContain("animation");

    const selectedTab = getAllByTestId("thread-tab").find((tab) => tab.getAttribute("data-thread-key") === "q-2")!;
    expect(within(selectedTab).getByTestId("thread-tab-select")).toHaveAttribute("aria-pressed", "true");
    expect(selectedTab).toHaveAttribute("data-active-output", "false");
    expect(selectedTab).toHaveClass("border-violet-100/45", "border-b-transparent", "text-white");
    expect(selectedTab).toHaveClass("bg-white/[0.055]");
    expect(selectedTab.className).not.toContain("rgba(139,92,246");
    expect(selectedTab).not.toHaveClass("border-amber-400/60", "border-cc-primary/70");
    expect(within(selectedTab).queryByTestId("thread-tab-active-output-indicator")).not.toBeInTheDocument();
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

  it("uses active phase color when an open tab has both active and completed board rows", () => {
    const repeatedActive: BoardRowData = {
      questId: "q-3",
      status: "USER_CHECKPOINTING",
      title: "Repeated Journey",
      journey: {
        presetId: "full-code",
        phaseIds: ["alignment", "explore", "user-checkpoint", "implement"],
        currentPhaseId: "user-checkpoint",
        activePhaseIndex: 2,
      },
      updatedAt: 4,
    };
    const repeatedCompleted: BoardRowData = {
      questId: "q-3",
      status: "PORTING",
      title: "Repeated Journey",
      journey: {
        presetId: "full-code",
        phaseIds: ["alignment", "implement", "code-review", "port"],
        currentPhaseId: "port",
        activePhaseIndex: 3,
      },
      updatedAt: 3,
      completedAt: 3,
    };
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", [...BOARD_DATA, repeatedActive]]]),
      sessionCompletedBoards: new Map([["s1", [repeatedCompleted]]]),
    });

    const { getAllByTestId } = render(<WorkBoardBar sessionId="s1" currentThreadKey="q-3" openThreadKeys={["q-3"]} />);

    const tab = getAllByTestId("thread-tab").find((candidate) => candidate.getAttribute("data-thread-key") === "q-3")!;
    expect(tab).toHaveAttribute("data-closable", "false");
    const title = within(tab).getByTestId("thread-tab-title");
    expect(title).toHaveStyle({
      color: getQuestJourneyPhaseForState("USER_CHECKPOINTING")?.color.accent,
    });
    expect(title).not.toHaveAttribute("data-title-color", "var(--color-cc-muted)");
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

  it("renders the active output marker while preserving needs-input bells and title phase color", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
      sessionStatus: new Map([["s1", "running"]]),
      activeTurnRoutes: new Map([["s1", { threadKey: "q-1", questId: "q-1" }]]),
    });

    const withBellView = render(
      <WorkBoardBar
        sessionId="s1"
        currentThreadKey="q-1"
        openThreadKeys={["q-1"]}
        attentionRecords={[attentionRecord({ id: "needs-input", state: "unresolved", dedupeKey: "needs-input" })]}
      />,
    );

    const needsInputTab = withBellView
      .getAllByTestId("thread-tab")
      .find((tab) => tab.getAttribute("data-thread-key") === "q-1")!;
    expect(needsInputTab).toHaveAttribute("data-active-output", "true");
    const { dot: needsInputDot } = expectStripeOriginActiveOutputMarker(needsInputTab);
    expect(within(needsInputTab).queryByTestId("thread-tab-status-dot")).not.toBeInTheDocument();
    const bell = within(needsInputTab).getByTestId("thread-tab-needs-input-bell");
    expect(bell).toHaveAttribute("data-active-output", "true");
    expect(bell).toHaveClass("relative", "z-10");
    expect(bell).not.toHaveClass("animate-pulse");
    const activeTitle = within(needsInputTab).getByTestId("thread-tab-title");
    expect(activeTitle).toHaveAttribute("data-active-output", "true");
    expect(activeTitle).toHaveStyle({
      color: getQuestJourneyPhaseForState("IMPLEMENTING")?.color.accent,
    });
    expect(activeTitle.getAttribute("style") ?? "").not.toContain("animation");
    expect(activeTitle).not.toHaveClass("border");
    expect(activeTitle).not.toHaveClass("bg-sky-400/10");
    expect(activeTitle).not.toHaveClass("text-sky-100");

    const inactiveTitle = withBellView
      .getAllByTestId("thread-tab-title")
      .find((title) => title.closest("[data-thread-key]")?.getAttribute("data-thread-key") === "q-2")!;
    expect(inactiveTitle).toBeTruthy();
    expect(inactiveTitle).toHaveAttribute("data-active-output", "false");
    expect(inactiveTitle.getAttribute("style") ?? "").not.toContain("animation");
    const inactiveTab = withBellView
      .getAllByTestId("thread-tab")
      .find((tab) => tab.getAttribute("data-thread-key") === "q-2")!;
    expect(inactiveTab).toHaveAttribute("data-active-output", "false");
    expect(within(inactiveTab).queryByTestId("thread-tab-active-output-indicator")).not.toBeInTheDocument();
    withBellView.unmount();

    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
      sessionStatus: new Map([["s1", "running"]]),
      activeTurnRoutes: new Map([["s1", { threadKey: "q-1", questId: "q-1" }]]),
    });

    const noBellView = render(<WorkBoardBar sessionId="s1" currentThreadKey="q-1" openThreadKeys={["q-1"]} />);
    const noBellTab = noBellView
      .getAllByTestId("thread-tab")
      .find((tab) => tab.getAttribute("data-thread-key") === "q-1")!;
    const { dot: noBellDot } = expectStripeOriginActiveOutputMarker(noBellTab);
    expect(noBellDot.className).toBe(needsInputDot.className);
    expect(within(noBellTab).queryByTestId("thread-tab-needs-input-bell")).not.toBeInTheDocument();
  });

  it("marks the output glint as reduced-motion-disabled while keeping the static marker contract", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
      sessionStatus: new Map([["s1", "running"]]),
      activeTurnRoutes: new Map([["s1", { threadKey: "q-1", questId: "q-1" }]]),
    });

    const { getAllByTestId } = render(<WorkBoardBar sessionId="s1" currentThreadKey="q-1" openThreadKeys={["q-1"]} />);

    const tab = getAllByTestId("thread-tab").find((candidate) => candidate.getAttribute("data-thread-key") === "q-1")!;
    const { glint } = expectStripeOriginActiveOutputMarker(tab);
    expect(glint).toHaveAttribute("data-reduced-motion", "animation-disabled");
  });

  it("keeps the active output glint mounted across rail rerenders while active state continues", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
      sessionStatus: new Map([["s1", "running"]]),
      activeTurnRoutes: new Map([["s1", { threadKey: "q-1", questId: "q-1" }]]),
    });

    const view = render(<WorkBoardBar sessionId="s1" currentThreadKey="q-1" openThreadKeys={["q-1"]} />);
    const tabBefore = view
      .getAllByTestId("thread-tab")
      .find((candidate) => candidate.getAttribute("data-thread-key") === "q-1")!;
    const markerBefore = within(tabBefore).getByTestId("thread-tab-active-output-indicator");
    const glintBefore = within(markerBefore).getByTestId("thread-tab-active-output-glint");

    view.rerender(<WorkBoardBar sessionId="s1" currentThreadKey="q-1" openThreadKeys={["q-1"]} />);

    const tabAfter = view
      .getAllByTestId("thread-tab")
      .find((candidate) => candidate.getAttribute("data-thread-key") === "q-1")!;
    const markerAfter = within(tabAfter).getByTestId("thread-tab-active-output-indicator");
    const glintAfter = within(markerAfter).getByTestId("thread-tab-active-output-glint");
    expect(markerAfter).toBe(markerBefore);
    expect(glintAfter).toBe(glintBefore);
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
    expect(onCloseThreadTab).toHaveBeenCalledWith("q-3", "q-2");
  });

  it("uses sibling select and close buttons for open tabs", () => {
    const onSelectThread = vi.fn();
    const onCloseThreadTab = vi.fn();
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", []]]),
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
    expect(onCloseThreadTab).toHaveBeenCalledWith("q-99", "main");
  });

  it("keeps select and close buttons usable when the tab surface is sortable", () => {
    const onSelectThread = vi.fn();
    const onCloseThreadTab = vi.fn();
    const onReorderThreadTabs = vi.fn();
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", []]]),
    });

    const { getAllByTestId, getByLabelText } = render(
      <WorkBoardBar
        sessionId="s1"
        openThreadKeys={["q-99"]}
        onSelectThread={onSelectThread}
        onCloseThreadTab={onCloseThreadTab}
        onReorderThreadTabs={onReorderThreadTabs}
        threadRows={[{ threadKey: "q-99", questId: "q-99", title: "Off-board thread", messageCount: 2 }]}
      />,
    );

    const tab = getAllByTestId("thread-tab").find((candidate) => candidate.getAttribute("data-thread-key") === "q-99")!;
    const selectButton = within(tab).getByTestId("thread-tab-select");
    const closeButton = getByLabelText("Close q-99");

    expect(within(tab).queryByTestId("thread-tab-drag-handle")).toBeNull();
    expect(selectButton).toHaveAttribute("aria-roledescription", "sortable");
    expect(closeButton).not.toHaveAttribute("aria-roledescription", "sortable");

    fireEvent.click(selectButton);
    expect(onSelectThread).toHaveBeenCalledWith("q-99");
    expect(onReorderThreadTabs).not.toHaveBeenCalled();

    fireEvent.click(closeButton);
    expect(onCloseThreadTab).toHaveBeenCalledWith("q-99", "main");
    expect(onSelectThread).toHaveBeenCalledTimes(1);
    expect(onReorderThreadTabs).not.toHaveBeenCalled();
  });

  it("only makes server-open quest/thread tab surfaces reorderable", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([
        ["s1", [{ questId: "q-2", status: "IMPLEMENTING", title: "Auto surfaced", updatedAt: 2 }]],
      ]),
      quests: [
        { questId: "q-1", title: "Open tab", status: "in_progress" } as QuestmasterTask,
        { questId: "q-2", title: "Auto surfaced", status: "in_progress" } as QuestmasterTask,
      ],
    });

    const { getByTestId, getAllByTestId } = render(
      <WorkBoardBar
        sessionId="s1"
        openThreadKeys={["q-1"]}
        onReorderThreadTabs={vi.fn()}
        threadRows={[
          { threadKey: "q-1", questId: "q-1", title: "Open tab" },
          { threadKey: "q-2", questId: "q-2", title: "Auto surfaced" },
        ]}
      />,
    );

    expect(getByTestId("thread-main-tab")).not.toHaveAttribute("data-reorderable", "true");
    const openTab = getAllByTestId("thread-tab").find((tab) => tab.getAttribute("data-thread-key") === "q-1")!;
    const surfacedTab = getAllByTestId("thread-tab").find((tab) => tab.getAttribute("data-thread-key") === "q-2")!;
    expect(openTab).toHaveAttribute("data-reorderable", "true");
    expect(within(openTab).queryByTestId("thread-tab-drag-handle")).toBeNull();
    expect(within(openTab).getByTestId("thread-tab-select")).toHaveAttribute("aria-roledescription", "sortable");
    expect(surfacedTab).toHaveAttribute("data-reorderable", "false");
    expect(within(surfacedTab).queryByTestId("thread-tab-drag-handle")).toBeNull();
    expect(within(surfacedTab).getByTestId("thread-tab-select")).not.toHaveAttribute(
      "aria-roledescription",
      "sortable",
    );
  });

  it("passes the right-hand visible tab as the active close fallback for persisted tabs", () => {
    const onSelectThread = vi.fn();
    const onCloseThreadTab = vi.fn();
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", []]]),
    });

    const { getAllByTestId, getByLabelText } = render(
      <WorkBoardBar
        sessionId="s1"
        currentThreadKey="q-middle"
        openThreadKeys={["q-left", "q-middle", "q-right"]}
        onSelectThread={onSelectThread}
        onCloseThreadTab={onCloseThreadTab}
        threadRows={[
          { threadKey: "q-left", questId: "q-left", title: "Left thread", messageCount: 1 },
          { threadKey: "q-middle", questId: "q-middle", title: "Selected thread", messageCount: 2 },
          { threadKey: "q-right", questId: "q-right", title: "Right thread", messageCount: 3 },
        ]}
      />,
    );

    // Preserve the current rendered tab order: the fallback should be the visible neighbor to the right.
    expect(getAllByTestId("thread-tab").map((tab) => tab.getAttribute("data-thread-key"))).toEqual([
      "q-left",
      "q-middle",
      "q-right",
    ]);

    fireEvent.click(getByLabelText("Close q-middle"));

    expect(onCloseThreadTab).toHaveBeenCalledWith("q-middle", "q-right");
    expect(onSelectThread).not.toHaveBeenCalled();
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
    const controls = getByTestId("workboard-thread-controls");
    expect(within(controls).getByTestId("workboard-thread-nav")).toBeInTheDocument();
    expect(within(controls).getByLabelText("Search threads, board, and history")).toBeInTheDocument();
    expect(getByTestId("workboard-thread-main")).toHaveAttribute("data-variant", "compact");
    expect(getByTestId("workboard-thread-main")).toHaveAttribute("data-secondary", "false");
    expect(getByTestId("workboard-thread-all")).toHaveAttribute("data-variant", "compact");
    expect(getByTestId("workboard-thread-all")).toHaveAttribute("data-secondary", "true");
    fireEvent.click(getByTestId("workboard-thread-main"));
    fireEvent.click(getByTestId("workboard-thread-all"));

    expect(onSelectThread).toHaveBeenNthCalledWith(1, "main");
    expect(onSelectThread).toHaveBeenNthCalledWith(2, "all");
  });

  it("keeps thread search compact until focused or populated", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
    });

    const { getByLabelText, getByTestId } = render(<WorkBoardBar sessionId="s1" onSelectThread={vi.fn()} />);
    fireEvent.click(getByTestId("workboard-summary-button"));

    const controls = getByTestId("workboard-thread-controls");
    const search = getByTestId("workboard-thread-search");
    const input = getByLabelText("Search threads, board, and history");
    expect(controls).toHaveAttribute("data-search-expanded", "false");
    expect(search).toHaveAttribute("data-expanded", "false");

    fireEvent.focus(input);
    expect(controls).toHaveAttribute("data-search-expanded", "true");
    expect(search).toHaveAttribute("data-expanded", "true");

    fireEvent.blur(input);
    expect(controls).toHaveAttribute("data-search-expanded", "false");
    expect(search).toHaveAttribute("data-expanded", "false");

    fireEvent.change(input, { target: { value: "q-99" } });
    expect(input).toHaveValue("q-99");
    expect(controls).toHaveAttribute("data-search-expanded", "true");
    expect(search).toHaveAttribute("data-expanded", "true");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue("");
    expect(getByTestId("board-table")).toBeInTheDocument();
    expect(controls).toHaveAttribute("data-search-expanded", "false");
    expect(search).toHaveAttribute("data-expanded", "false");

    fireEvent.change(input, { target: { value: "q-99" } });
    fireEvent.click(getByLabelText("Clear thread search"));
    expect(input).toHaveValue("");
    expect(controls).toHaveAttribute("data-search-expanded", "false");
    expect(search).toHaveAttribute("data-expanded", "false");
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
    expect(getByTestId("workboard-off-board-threads")).toHaveTextContent("1 other");
    expect(getByTestId("workboard-other-threads-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(getByTestId("workboard-phase-summary")).toHaveTextContent("1 other");
    expect(getByTestId("workboard-off-board-threads")).not.toHaveTextContent("Off-board thread");
    fireEvent.click(getByTestId("workboard-other-threads-toggle"));
    expect(getByTestId("workboard-other-threads-toggle")).toHaveAttribute("aria-expanded", "true");
    expect(getByTestId("workboard-other-threads-content")).toHaveTextContent("Off-board thread");
    fireEvent.click(getByTestId("workboard-off-board-thread"));
    expect(onSelectThread).toHaveBeenCalledWith("q-99");
  });

  it("persists the Other Threads expanded state per session", () => {
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

    const threadRows = [{ threadKey: "q-99", questId: "q-99", title: "Off-board thread", messageCount: 2 }];
    const view = render(<WorkBoardBar sessionId="s1" onSelectThread={vi.fn()} threadRows={threadRows} />);
    fireEvent.click(view.getByTestId("workboard-summary-button"));
    fireEvent.click(view.getByTestId("workboard-other-threads-toggle"));

    expect(view.getByTestId("workboard-other-threads-content")).toHaveTextContent("Off-board thread");
    expect(localStorage.getItem(scopedKey("cc-work-board-other-threads-expanded:s1"))).toBe("1");

    view.rerender(<WorkBoardBar sessionId="s2" onSelectThread={vi.fn()} threadRows={threadRows} />);
    fireEvent.click(view.getByTestId("workboard-summary-button"));
    expect(view.getByTestId("workboard-other-threads-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(view.queryByTestId("workboard-other-threads-content")).not.toBeInTheDocument();

    view.rerender(<WorkBoardBar sessionId="s1" onSelectThread={vi.fn()} threadRows={threadRows} />);
    expect(view.getByTestId("workboard-other-threads-toggle")).toHaveAttribute("aria-expanded", "true");
    expect(view.getByTestId("workboard-other-threads-content")).toHaveTextContent("Off-board thread");
  });

  it("keeps Work Board expansion state in memory when scoped localStorage writes hit quota", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
    });
    // Simulate the reported browser condition: the tiny preference write fails
    // because overall localStorage quota is already exhausted.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function setItem(this: Storage, key, value) {
      const storageKey = String(key);
      if (
        storageKey.includes("cc-work-board-expanded") ||
        storageKey.includes("cc-work-board-other-threads-expanded")
      ) {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      }
      return originalSetItem.call(this, key, value);
    });

    const threadRows = [{ threadKey: "q-99", questId: "q-99", title: "Off-board thread", messageCount: 2 }];
    const view = render(<WorkBoardBar sessionId="s1" onSelectThread={vi.fn()} threadRows={threadRows} />);

    fireEvent.click(view.getByTestId("workboard-summary-button"));
    expect(view.getByTestId("board-table")).toBeInTheDocument();

    fireEvent.click(view.getByTestId("workboard-other-threads-toggle"));
    expect(view.getByTestId("workboard-other-threads-toggle")).toHaveAttribute("aria-expanded", "true");
    expect(view.getByTestId("workboard-other-threads-content")).toHaveTextContent("Off-board thread");
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not persist Work Board storage value"),
      expect.any(DOMException),
    );
  });

  it("falls back to collapsed Work Board state when scoped localStorage reads fail", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
    });
    // Some browsers can throw on storage reads in restricted/quota states; the
    // Work Board should render collapsed instead of tripping the error boundary.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const originalGetItem = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function getItem(this: Storage, key) {
      const storageKey = String(key);
      if (
        storageKey.includes("cc-work-board-expanded") ||
        storageKey.includes("cc-work-board-other-threads-expanded")
      ) {
        throw new DOMException("Read failed", "SecurityError");
      }
      return originalGetItem.call(this, key);
    });

    const threadRows = [{ threadKey: "q-99", questId: "q-99", title: "Off-board thread", messageCount: 2 }];
    const view = render(<WorkBoardBar sessionId="s1" onSelectThread={vi.fn()} threadRows={threadRows} />);

    expect(view.queryByTestId("board-table")).not.toBeInTheDocument();
    fireEvent.click(view.getByTestId("workboard-summary-button"));
    expect(view.getByTestId("workboard-other-threads-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not read Work Board storage value"),
      expect.any(DOMException),
    );
  });

  it("ignores oversized legacy Work Board boolean storage values", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      sessionBoards: new Map([["s1", BOARD_DATA]]),
    });
    // These keys are boolean hints, so legacy values larger than the expected
    // "1"/"0" shape are discarded rather than trusted.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    localStorage.setItem(scopedKey("cc-work-board-expanded:s1"), "1".repeat(128));
    localStorage.setItem(scopedKey("cc-work-board-other-threads-expanded:s1"), "1".repeat(128));

    const threadRows = [{ threadKey: "q-99", questId: "q-99", title: "Off-board thread", messageCount: 2 }];
    const view = render(<WorkBoardBar sessionId="s1" onSelectThread={vi.fn()} threadRows={threadRows} />);

    expect(view.queryByTestId("board-table")).not.toBeInTheDocument();
    fireEvent.click(view.getByTestId("workboard-summary-button"));
    expect(view.getByTestId("workboard-other-threads-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("Ignoring oversized Work Board storage value"),
      expect.objectContaining({ length: 128 }),
    );
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

    expect(getByTestId("workboard-other-threads-toggle")).toHaveTextContent("1 other");
    expect(getByTestId("workboard-other-threads-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(getByTestId("workboard-off-board-threads")).not.toHaveTextContent("Archived follow-up thread");
    expect(queryByText("No active items match")).toBeInTheDocument();

    fireEvent.click(getByTestId("workboard-other-threads-toggle"));
    expect(getByTestId("workboard-other-threads-content")).toHaveTextContent("Archived follow-up thread");
  });
});
