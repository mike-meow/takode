// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { BoardBlock } from "./BoardBlock.js";
import type { BoardRowData } from "./BoardTable.js";
import type { BoardRowSessionStatus } from "../types.js";

const liveRowSessionStatuses = new Map<string, Record<string, BoardRowSessionStatus>>();

vi.mock("../store.js", () => ({
  useStore: (
    selector: (state: {
      latestBoardToolUseId: Map<string, string>;
      sessionBoardRowStatuses: Map<string, Record<string, import("../types.js").BoardRowSessionStatus>>;
      setLatestBoardToolUseId: () => void;
    }) => unknown,
  ) =>
    selector({
      latestBoardToolUseId: new Map<string, string>(),
      sessionBoardRowStatuses: liveRowSessionStatuses,
      setLatestBoardToolUseId: () => {},
    }),
}));

vi.mock("./BoardTable.js", () => ({
  BoardTable: ({
    board,
    rowSessionStatuses,
  }: {
    board: BoardRowData[];
    rowSessionStatuses?: Record<string, BoardRowSessionStatus>;
  }) => (
    <div data-testid="board-table" data-statuses={JSON.stringify(rowSessionStatuses ?? null)}>
      {board.length} rows
    </div>
  ),
}));

vi.mock("./CollapseFooter.js", () => ({
  CollapseFooter: () => null,
}));

describe("BoardBlock", () => {
  beforeEach(() => {
    liveRowSessionStatuses.clear();
  });

  it("prefers explicit row session statuses over the live store snapshot", () => {
    const board: BoardRowData[] = [{ questId: "q-42", title: "Quest", updatedAt: 1 }];
    liveRowSessionStatuses.set("s-1", {
      "q-42": { worker: { sessionId: "worker-live", sessionNum: 9, status: "idle" }, reviewer: null },
    });

    render(
      <BoardBlock
        board={board}
        sessionId="s-1"
        rowSessionStatuses={{
          "q-42": {
            worker: { sessionId: "worker-inline", sessionNum: 12, status: "running" },
            reviewer: { sessionId: "reviewer-inline", sessionNum: 13, status: "running" },
          },
        }}
      />,
    );

    expect(screen.getByTestId("board-table")).toHaveAttribute(
      "data-statuses",
      JSON.stringify({
        "q-42": {
          worker: { sessionId: "worker-inline", sessionNum: 12, status: "running" },
          reviewer: { sessionId: "reviewer-inline", sessionNum: 13, status: "running" },
        },
      }),
    );
  });

  it("formats embedded quest journey enum labels in the operation header", () => {
    const board: BoardRowData[] = [{ questId: "q-42", title: "Quest", updatedAt: 1 }];

    render(<BoardBlock board={board} operation="advanced q-42 to CODE_REVIEWING" />);

    expect(screen.getByText("-- advanced q-42 to Code Review")).toBeInTheDocument();
    expect(screen.queryByText(/CODE_REVIEWING/)).toBeNull();
  });

  it("renders queue warnings when present", () => {
    const board: BoardRowData[] = [{ questId: "q-42", title: "Quest", updatedAt: 1 }];

    render(
      <BoardBlock
        board={board}
        queueWarnings={[
          {
            questId: "q-42",
            kind: "dispatchable",
            summary: "q-42 can be dispatched now: wait-for resolved (q-9).",
            action: "Dispatch it now.",
          },
        ]}
      />,
    );

    expect(screen.getByText("Queue Warnings")).toBeInTheDocument();
    expect(screen.getByText(/q-42 can be dispatched now/i)).toBeInTheDocument();
    expect(screen.getByText(/Next: Dispatch it now\./i)).toBeInTheDocument();
  });

  it("renders an explicit proposal review artifact above the board table", () => {
    const board: BoardRowData[] = [{ questId: "q-942", title: "Draft workflow", updatedAt: 1 }];

    render(
      <BoardBlock
        board={board}
        operation="present q-942"
        proposalReview={{
          questId: "q-942",
          title: "Draft workflow",
          status: "PROPOSED",
          presentedAt: 123,
          summary: "Proposed Journey for approval",
          journey: {
            mode: "proposed",
            phaseIds: ["alignment", "implement", "code-review"],
            phaseNotes: {
              "1": "Build the draft and present paths.",
            },
          },
        }}
      />,
    );

    expect(screen.getByTestId("quest-journey-proposal-review")).toBeInTheDocument();
    expect(screen.getByText("Presented Journey Proposal")).toBeInTheDocument();
    expect(screen.getByText("Proposed Journey for approval")).toBeInTheDocument();
    expect(screen.getByText("Build the draft and present paths.")).toHaveAttribute("data-purpose-kind", "authored");
    expect(screen.getByText("Build the draft and present paths.")).toHaveClass("ml-[1.375rem]");
  });
});
