// @vitest-environment jsdom
import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { BoardTable, formatCompletedTime, orderBoardRows, type BoardRowData } from "./BoardTable.js";
import { getQuestJourneyPhaseForState } from "../../shared/quest-journey.js";

interface MockStoreState {
  quests: Array<{
    questId: string;
    title?: string;
    status?: string;
    createdAt?: number;
    version?: number;
    id?: string;
  }>;
  sdkSessions: Array<{ sessionId: string; sessionNum?: number }>;
  zoomLevel?: number;
}

const { openQuestOverlay, useStoreMock } = vi.hoisted(() => {
  const openQuestOverlay = vi.fn();
  const useStoreMock = Object.assign((selector: (s: MockStoreState) => unknown) => selector(mockState), {
    getState: () => ({ openQuestOverlay }),
  });
  return { openQuestOverlay, useStoreMock };
});

let mockState: MockStoreState;

vi.mock("../store.js", () => ({
  useStore: useStoreMock,
  countUserPermissions: () => 0,
}));

vi.mock("./SessionInlineLink.js", () => ({
  SessionInlineLink: ({ children, className }: { children: ReactNode; className?: string }) => (
    <span data-testid="session-inline-link" className={className}>
      {children}
    </span>
  ),
}));

beforeEach(() => {
  mockState = {
    quests: [],
    sdkSessions: [],
  };
  openQuestOverlay.mockReset();
});

describe("BoardTable", () => {
  it("shows Wait For for active board rows", () => {
    const board: BoardRowData[] = [{ questId: "q-335", title: "Show completed time", updatedAt: 1 }];

    render(<BoardTable board={board} />);

    expect(screen.getAllByRole("columnheader").map((node) => node.textContent)).toEqual([
      "Quest",
      "Sessions",
      "Journey",
      "Title",
      "Wait For",
    ]);
    expect(screen.getByRole("columnheader", { name: "Wait For" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Completed Time" })).not.toBeInTheDocument();
  });

  it("shows Completed Time instead of Wait For for completed rows", () => {
    const completedAt = Date.UTC(2026, 3, 16, 18, 45, 0);
    const board: BoardRowData[] = [
      {
        questId: "q-335",
        title: "Show completed time",
        status: "PORTING",
        waitFor: ["q-999"],
        updatedAt: completedAt,
        completedAt,
      },
    ];

    render(<BoardTable board={board} mode="completed" />);

    expect(screen.getByRole("columnheader", { name: "Completed Time" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Wait For" })).not.toBeInTheDocument();
    expect(screen.getByText(formatCompletedTime(completedAt))).toBeInTheDocument();
    expect(screen.queryByText("q-999")).not.toBeInTheDocument();
  });

  it("renders an em dash when a completed row is missing completedAt", () => {
    const board: BoardRowData[] = [{ questId: "q-335", title: "Show completed time", updatedAt: 1 }];

    render(<BoardTable board={board} mode="completed" />);

    expect(screen.getByRole("columnheader", { name: "Completed Time" })).toBeInTheDocument();
    expect(screen.getAllByText("\u2014").length).toBeGreaterThan(0);
  });

  it("renders quest-journey labels with phase metadata colors", () => {
    const board: BoardRowData[] = [
      { questId: "q-1", status: "QUEUED", updatedAt: 1 },
      { questId: "q-2", status: "PLANNING", updatedAt: 2 },
      { questId: "q-3", status: "EXPLORING", updatedAt: 3 },
      { questId: "q-4", status: "IMPLEMENTING", updatedAt: 4 },
      { questId: "q-5", status: "CODE_REVIEWING", updatedAt: 5 },
      { questId: "q-6", status: "MENTAL_SIMULATING", updatedAt: 6 },
      { questId: "q-7", status: "OUTCOME_REVIEWING", updatedAt: 7 },
      { questId: "q-8", status: "BOOKKEEPING", updatedAt: 8 },
      { questId: "q-9", status: "PORTING", updatedAt: 9 },
    ];

    render(<BoardTable board={board} />);

    expect(screen.getByText("Queued")).toHaveClass("text-cc-muted");
    expect(screen.getByText("Alignment")).toHaveStyle({
      color: getQuestJourneyPhaseForState("PLANNING")?.color.accent,
    });
    expect(screen.getByText("Explore")).toHaveStyle({
      color: getQuestJourneyPhaseForState("EXPLORING")?.color.accent,
    });
    expect(screen.getByText("Implement")).toHaveStyle({
      color: getQuestJourneyPhaseForState("IMPLEMENTING")?.color.accent,
    });
    expect(screen.getByText("Code Review")).toHaveStyle({
      color: getQuestJourneyPhaseForState("CODE_REVIEWING")?.color.accent,
    });
    expect(screen.getByText("Mental Simulation")).toHaveStyle({
      color: getQuestJourneyPhaseForState("MENTAL_SIMULATING")?.color.accent,
    });
    expect(screen.getByText("Outcome Review")).toHaveStyle({
      color: getQuestJourneyPhaseForState("OUTCOME_REVIEWING")?.color.accent,
    });
    expect(screen.getByText("Bookkeeping")).toHaveStyle({
      color: getQuestJourneyPhaseForState("BOOKKEEPING")?.color.accent,
    });
    expect(screen.getByText("Port")).toHaveStyle({
      color: getQuestJourneyPhaseForState("PORTING")?.color.accent,
    });
  });

  it("falls back to the raw status for unknown values", () => {
    const board: BoardRowData[] = [{ questId: "q-1", status: "CUSTOM_STATUS", updatedAt: 1 }];

    render(<BoardTable board={board} />);

    expect(screen.getByText("CUSTOM_STATUS")).toHaveClass("text-cc-muted");
  });

  it("keeps board Journey rendering compact and current-phase-first", () => {
    const board: BoardRowData[] = [
      {
        questId: "q-1",
        status: "IMPLEMENTING",
        journey: {
          presetId: "full-code",
          phaseIds: ["alignment", "implement", "code-review", "port"],
          currentPhaseId: "implement",
          phaseNotes: { "2": "Inspect only the follow-up diff" },
          revisionReason: "Need code review before port",
        },
        updatedAt: 1,
      },
    ];

    render(<BoardTable board={board} />);

    const summary = screen.getByTestId("quest-journey-compact-summary");
    expect(summary).toHaveAttribute("data-journey-mode", "active");
    expect(within(summary).getByText("Implement")).toBeInTheDocument();
    expect(within(summary).getByText("2/4")).toBeInTheDocument();
    expect(within(summary).getByText("1 note")).toBeInTheDocument();
    expect(summary).toHaveAttribute("title", "Journey revised: Need code review before port");
    expect(screen.queryByText("Alignment")).not.toBeInTheDocument();
    expect(screen.queryByText("Inspect only the follow-up diff")).not.toBeInTheDocument();
  });

  it("summarizes the active repeated phase occurrence by position", () => {
    const board: BoardRowData[] = [
      {
        questId: "q-720",
        status: "MENTAL_SIMULATING",
        journey: {
          presetId: "simulation-loop",
          phaseIds: [
            "alignment",
            "implement",
            "mental-simulation",
            "implement",
            "mental-simulation",
            "code-review",
            "port",
          ],
          activePhaseIndex: 4,
          currentPhaseId: "mental-simulation",
        },
        updatedAt: 1,
      },
    ];

    render(<BoardTable board={board} />);

    const summary = screen.getByTestId("quest-journey-compact-summary");
    expect(within(summary).getByText("Mental Simulation")).toBeInTheDocument();
    expect(within(summary).getByText("5/7")).toBeInTheDocument();
  });

  it("renders proposed Journey rows as scheduling previews with the phase sequence in compact board cells", () => {
    const board: BoardRowData[] = [
      {
        questId: "q-924",
        status: "PROPOSED",
        journey: {
          mode: "proposed",
          presetId: "full-code",
          phaseIds: ["alignment", "implement", "code-review", "port"],
          activePhaseIndex: 1,
          currentPhaseId: "implement",
        },
        updatedAt: 1,
      },
    ];

    render(<BoardTable board={board} />);

    const summary = screen.getByTestId("quest-journey-compact-summary");
    expect(summary).toHaveAttribute("data-journey-mode", "proposed");
    expect(within(summary).getByText("Proposed")).toBeInTheDocument();
    expect(within(summary).getByTestId("quest-journey-compact-sequence")).toHaveTextContent(
      "Alignment -> Implement -> Code Review -> Port",
    );
    expect(within(summary).getByText("4 phases")).toBeInTheDocument();
  });

  it("shows the full Journey preview on Work Board Journey hover", async () => {
    mockState.quests = [
      {
        id: "q-924-v1",
        questId: "q-924",
        version: 1,
        title: "Make Journey UI useful",
        status: "refined",
        createdAt: 1,
      },
    ];
    const board: BoardRowData[] = [
      {
        questId: "q-924",
        title: "Fallback title",
        status: "PROPOSED",
        journey: {
          mode: "proposed",
          presetId: "full-code",
          phaseIds: ["alignment", "implement", "code-review"],
          phaseNotes: {
            "1": "Build the compact preview UI",
          },
        },
        updatedAt: 1,
      },
    ];

    render(<BoardTable board={board} />);
    fireEvent.mouseEnter(screen.getByTestId("board-journey-hover-target"));

    const card = await screen.findByTestId("board-journey-hover-card");
    expect(within(card).getByText("q-924")).toBeInTheDocument();
    expect(within(card).getByText("Make Journey UI useful")).toBeInTheDocument();
    expect(within(card).getByText("Alignment")).toBeInTheDocument();
    expect(within(card).getByText("Implement")).toBeInTheDocument();
    expect(within(card).getByText("Code Review")).toBeInTheDocument();
    expect(within(card).getByText("Build the compact preview UI")).toHaveAttribute("data-purpose-kind", "authored");
    expect(within(card).getByText("Build the compact preview UI")).toHaveClass("ml-[1.375rem]");
    expect(within(card).getByText(/Do a lightweight read-in/)).toHaveAttribute("data-purpose-kind", "default");

    fireEvent.click(within(card).getByRole("button", { name: /q-924 Make Journey UI useful/ }));
    expect(openQuestOverlay).toHaveBeenCalledWith("q-924");
  });

  it("renders worker and reviewer session links in a wrapping same-line row with their own status dots", () => {
    const board: BoardRowData[] = [{ questId: "q-1", worker: "worker-1", workerNum: 11, updatedAt: 1 }];

    render(
      <BoardTable
        board={board}
        rowSessionStatuses={{
          "q-1": {
            worker: { sessionId: "worker-1", sessionNum: 11, status: "running" },
            reviewer: { sessionId: "reviewer-1", sessionNum: 12, status: "idle" },
          },
        }}
      />,
    );

    expect(screen.getByText("#11")).toBeInTheDocument();
    expect(screen.getByText("#12")).toBeInTheDocument();
    const sessionsCell = screen.getByText("#11").closest("td");
    expect(sessionsCell).toHaveClass("min-w-[8rem]", "whitespace-normal");
    const sessionsLayout = screen.getByText("#11").closest("div");
    expect(sessionsLayout).toHaveClass("flex-row", "flex-wrap", "gap-x-3", "gap-y-1");
    expect(sessionsLayout).not.toHaveClass("flex-col");
    const dots = screen.getAllByTestId("session-status-dot");
    expect(dots).toHaveLength(2);
    expect(dots[0]).toHaveAttribute("data-status", "running");
    expect(dots[1]).toHaveAttribute("data-status", "idle");
  });

  it("renders only linked wait-for-input ids for active rows", () => {
    const board: BoardRowData[] = [
      {
        questId: "q-1",
        status: "IMPLEMENTING",
        waitForInput: ["n-3", "n-8"],
        waitFor: ["q-2"],
        updatedAt: 1,
      },
    ];

    render(<BoardTable board={board} />);

    expect(screen.getByText("input 3")).toBeInTheDocument();
    expect(screen.getByText("input 8")).toBeInTheDocument();
    expect(screen.queryByText("q-2")).not.toBeInTheDocument();
  });

  it("orders active rows by journey status priority first", () => {
    const ordered = orderBoardRows([
      { questId: "q-1", status: "PORTING", updatedAt: 1 },
      { questId: "q-2", status: "QUEUED", updatedAt: 2 },
      { questId: "q-3", status: "IMPLEMENTING", updatedAt: 3 },
    ]);

    expect(ordered.map((row) => row.questId)).toEqual(["q-1", "q-3", "q-2"]);
  });

  it("orders rows by recency within the same status when there are no dependencies", () => {
    const ordered = orderBoardRows([
      { questId: "q-1", status: "IMPLEMENTING", updatedAt: 1_000 },
      { questId: "q-2", status: "IMPLEMENTING", updatedAt: 5_000 },
      { questId: "q-3", status: "IMPLEMENTING", updatedAt: 3_000 },
    ]);

    expect(ordered.map((row) => row.questId)).toEqual(["q-2", "q-3", "q-1"]);
  });

  it("topologically orders queued rows based on quest wait-for dependencies", () => {
    const ordered = orderBoardRows([
      { questId: "q-3", status: "QUEUED", updatedAt: 9_000, waitFor: ["q-2"] },
      { questId: "q-1", status: "QUEUED", updatedAt: 1_000 },
      { questId: "q-2", status: "QUEUED", updatedAt: 5_000, waitFor: ["q-1"] },
    ]);

    expect(ordered.map((row) => row.questId)).toEqual(["q-1", "q-2", "q-3"]);
  });

  it("ignores missing dependencies and falls back safely on cycles within queued rows", () => {
    const ordered = orderBoardRows([
      { questId: "q-1", status: "QUEUED", updatedAt: 1_000, waitFor: ["q-999"] },
      { questId: "q-2", status: "QUEUED", updatedAt: 3_000, waitFor: ["q-3"] },
      { questId: "q-3", status: "QUEUED", updatedAt: 2_000, waitFor: ["q-2"] },
    ]);

    expect(ordered.map((row) => row.questId)).toEqual(["q-2", "q-3", "q-1"]);
  });
});
