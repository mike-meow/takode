// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { BoardTable, formatCompletedTime, type BoardRowData } from "./BoardTable.js";

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
      { questId: "q-3", status: "IMPLEMENTING", updatedAt: 3 },
      { questId: "q-4", status: "SKEPTIC_REVIEWING", updatedAt: 4 },
      { questId: "q-5", status: "GROOM_REVIEWING", updatedAt: 5 },
      { questId: "q-6", status: "PORTING", updatedAt: 6 },
    ];

    render(<BoardTable board={board} />);

    expect(screen.getByText("Queued")).toHaveClass("text-cc-muted");
    expect(screen.getByText("Planning")).toHaveClass("text-green-400");
    expect(screen.getByText("Implementing")).toHaveClass("text-green-400");
    expect(screen.getByText("Skeptic Review")).toHaveClass("text-violet-500");
    expect(screen.getByText("Groom Review")).toHaveClass("text-violet-500");
    expect(screen.getByText("Porting")).toHaveClass("text-blue-400");
  });

  it("falls back to the raw status for unknown values", () => {
    const board: BoardRowData[] = [{ questId: "q-1", status: "CUSTOM_STATUS", updatedAt: 1 }];

    render(<BoardTable board={board} />);

    expect(screen.getByText("CUSTOM_STATUS")).toHaveClass("text-cc-muted");
  });
});
