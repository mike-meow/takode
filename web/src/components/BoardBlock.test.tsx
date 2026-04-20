// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { BoardBlock } from "./BoardBlock.js";
import type { BoardRowData } from "./BoardTable.js";

vi.mock("../store.js", () => ({
  useStore: (
    selector: (state: { latestBoardToolUseId: Map<string, string>; setLatestBoardToolUseId: () => void }) => unknown,
  ) =>
    selector({
      latestBoardToolUseId: new Map<string, string>(),
      setLatestBoardToolUseId: () => {},
    }),
}));

vi.mock("./BoardTable.js", () => ({
  BoardTable: ({ board }: { board: BoardRowData[] }) => <div data-testid="board-table">{board.length} rows</div>,
}));

vi.mock("./CollapseFooter.js", () => ({
  CollapseFooter: () => null,
}));

describe("BoardBlock", () => {
  it("formats embedded quest journey enum labels in the operation header", () => {
    const board: BoardRowData[] = [{ questId: "q-42", title: "Quest", updatedAt: 1 }];

    render(<BoardBlock board={board} operation="advanced q-42 to SKEPTIC_REVIEWING" />);

    expect(screen.getByText("-- advanced q-42 to Addressing Skeptic")).toBeInTheDocument();
    expect(screen.queryByText(/SKEPTIC_REVIEWING/)).toBeNull();
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
});
