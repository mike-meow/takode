// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { BoardTable, formatCompletedTime, orderBoardRows, type BoardRowData } from "./BoardTable.js";

interface MockStoreState {
  quests: Array<{ questId: string }>;
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

beforeEach(() => {
  mockState = {
    quests: [],
  };
  openQuestOverlay.mockReset();
});

describe("BoardTable", () => {
  it("shows Wait For for active board rows", () => {
    const board: BoardRowData[] = [{ questId: "q-335", title: "Show completed time", updatedAt: 1 }];

    render(<BoardTable board={board} />);

    expect(screen.getAllByRole("columnheader").map((node) => node.textContent)).toEqual([
      "Quest",
      "Worker",
      "Status",
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

  it("renders quest-journey labels with the approved text-only colors", () => {
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
    expect(screen.getByText("Alignment")).toHaveClass("text-green-400");
    expect(screen.getByText("Explore")).toHaveClass("text-amber-400");
    expect(screen.getByText("Implement")).toHaveClass("text-green-400");
    expect(screen.getByText("Code Review")).toHaveClass("text-violet-500");
    expect(screen.getByText("Mental Simulation")).toHaveClass("text-fuchsia-400");
    expect(screen.getByText("Outcome Review")).toHaveClass("text-cyan-400");
    expect(screen.getByText("Bookkeeping")).toHaveClass("text-yellow-300");
    expect(screen.getByText("Port")).toHaveClass("text-blue-400");
  });

  it("falls back to the raw status for unknown values", () => {
    const board: BoardRowData[] = [{ questId: "q-1", status: "CUSTOM_STATUS", updatedAt: 1 }];

    render(<BoardTable board={board} />);

    expect(screen.getByText("CUSTOM_STATUS")).toHaveClass("text-cc-muted");
  });

  it("renders current Quest Journey phase when phase bookkeeping is present", () => {
    const board: BoardRowData[] = [
      {
        questId: "q-1",
        status: "IMPLEMENTING",
        journey: {
          presetId: "full-code",
          phaseIds: ["alignment", "implement", "code-review", "port"],
          currentPhaseId: "implement",
          revisionReason: "Need code review before port",
        },
        updatedAt: 1,
      },
    ];

    render(<BoardTable board={board} />);

    expect(screen.getByText("Implement")).toHaveAttribute(
      "title",
      expect.stringContaining("Alignment -> Implement -> Code Review -> Port"),
    );
    expect(screen.getByText("Implement")).toHaveAttribute(
      "title",
      expect.stringContaining("revised: Need code review before port"),
    );
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

  it("topologically orders rows within a status group based on quest wait-for dependencies", () => {
    const ordered = orderBoardRows([
      { questId: "q-3", status: "IMPLEMENTING", updatedAt: 9_000, waitFor: ["q-2"] },
      { questId: "q-1", status: "IMPLEMENTING", updatedAt: 1_000 },
      { questId: "q-2", status: "IMPLEMENTING", updatedAt: 5_000, waitFor: ["q-1"] },
    ]);

    expect(ordered.map((row) => row.questId)).toEqual(["q-1", "q-2", "q-3"]);
  });

  it("ignores missing dependencies and falls back safely on cycles within a status group", () => {
    const ordered = orderBoardRows([
      { questId: "q-1", status: "IMPLEMENTING", updatedAt: 1_000, waitFor: ["q-999"] },
      { questId: "q-2", status: "IMPLEMENTING", updatedAt: 3_000, waitFor: ["q-3"] },
      { questId: "q-3", status: "IMPLEMENTING", updatedAt: 2_000, waitFor: ["q-2"] },
    ]);

    expect(ordered.map((row) => row.questId)).toEqual(["q-2", "q-3", "q-1"]);
  });
});
