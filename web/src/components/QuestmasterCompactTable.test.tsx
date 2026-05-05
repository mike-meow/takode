// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { QuestmasterTask } from "../types.js";
import { CompactQuestTable } from "./QuestmasterCompactTable.js";

const mockStore = vi.hoisted(() => ({
  openQuestOverlay: vi.fn(),
  sdkSessions: [
    {
      sessionId: "worker-101",
      sessionNum: 101,
      state: "idle",
      cwd: "/tmp",
      createdAt: 1,
      archived: false,
    },
    {
      sessionId: "leader-202",
      sessionNum: 202,
      state: "idle",
      cwd: "/tmp",
      createdAt: 1,
      archived: false,
    },
  ],
  sessionNames: new Map<string, string>(),
}));

vi.mock("../store.js", () => {
  const useStore = (selector: (state: typeof mockStore) => unknown) => selector(mockStore);
  useStore.getState = () => mockStore;
  return { useStore };
});

function buildQuest(overrides: Partial<QuestmasterTask> = {}): QuestmasterTask {
  return {
    id: "q-100-v1",
    questId: "q-100",
    version: 1,
    title: "Relationship selection row",
    status: "done",
    description: "Table rows keep relationship metadata out of the Title column.",
    tldr: "The selection preview keeps compact row text readable.",
    createdAt: 1,
    updatedAt: 2,
    completedAt: 3,
    statusChangedAt: 3,
    sessionId: "worker-101",
    leaderSessionId: "leader-202",
    tags: ["ui", "relationships", "table"],
    verificationItems: [
      { text: "Preserve compact columns", checked: true },
      { text: "Hide title relationships", checked: false },
    ],
    feedback: [
      { author: "human", text: "Please verify compact rows.", ts: 4, addressed: false },
      { author: "human", text: "Looks good elsewhere.", ts: 5, addressed: true },
    ],
    relatedQuests: [
      { questId: "q-201", kind: "follow_up_of", explicit: true },
      { questId: "q-202", kind: "has_follow_up", explicit: true },
      { questId: "q-203", kind: "referenced_by", explicit: false },
    ],
    ...overrides,
  } as QuestmasterTask;
}

describe("CompactQuestTable", () => {
  beforeEach(() => {
    mockStore.openQuestOverlay.mockClear();
  });

  it("omits relationship metadata from compact title rows while preserving row content and activation", () => {
    const quest = buildQuest();
    const onOpenQuest = vi.fn();

    render(
      <CompactQuestTable
        quests={[quest]}
        onOpenQuest={onOpenQuest}
        searchText="selection"
        journeyContextByQuestId={new Map()}
        sort={{ column: "updated", direction: "desc" }}
        sortSaving={false}
        onSortChange={vi.fn()}
      />,
    );

    const row = screen.getByRole("button", { name: /q-100.*Relationship.*selection.*row/ });
    expect(within(row).getByText("Relationship")).toBeInTheDocument();
    expect(within(row).getAllByText("selection").length).toBeGreaterThan(0);
    expect(within(row).getByText("#ui")).toBeInTheDocument();
    expect(within(row).getByTestId("quest-compact-tldr")).toHaveTextContent(
      "The selection preview keeps compact row text readable.",
    );
    expect(within(row).getByRole("link", { name: "q-100" })).toBeInTheDocument();
    expect(within(row).getByText("#101")).toBeInTheDocument();
    expect(within(row).getByText("#202")).toBeInTheDocument();
    expect(within(row).getByText("Completed")).toBeInTheDocument();
    expect(within(row).getByText("1/2")).toBeInTheDocument();
    expect(within(row).getByText("1 open / 2")).toBeInTheDocument();

    expect(within(row).queryByText("Follow-up of")).not.toBeInTheDocument();
    expect(within(row).queryByText("Has follow-up")).not.toBeInTheDocument();
    expect(within(row).queryByText("Referenced by")).not.toBeInTheDocument();
    expect(within(row).queryByRole("link", { name: "q-201" })).not.toBeInTheDocument();
    expect(within(row).queryByRole("link", { name: "q-202" })).not.toBeInTheDocument();
    expect(within(row).queryByRole("link", { name: "q-203" })).not.toBeInTheDocument();

    fireEvent.click(row);
    expect(onOpenQuest).toHaveBeenCalledWith(quest);
    fireEvent.keyDown(row, { key: "Enter" });
    expect(onOpenQuest).toHaveBeenCalledTimes(2);
  });

  it("keeps copy controls in a stable compact quest-id mini-column", () => {
    const shortQuest = buildQuest({ id: "q-769-v1", questId: "q-769", title: "Short quest id" });
    const longQuest = buildQuest({ id: "q-1153-v1", questId: "q-1153", title: "Long quest id" });

    render(
      <CompactQuestTable
        quests={[shortQuest, longQuest]}
        onOpenQuest={vi.fn()}
        searchText=""
        journeyContextByQuestId={new Map()}
        sort={{ column: "updated", direction: "desc" }}
        sortSaving={false}
        onSortChange={vi.fn()}
      />,
    );

    // JSDOM cannot measure rendered x-positions, so this asserts the observable
    // layout contract: every row uses the same fixed ID track before the icon.
    const controls = screen.getAllByTestId("quest-compact-id-controls");
    expect(controls).toHaveLength(2);
    controls.forEach((control) => {
      expect(control).toHaveClass("inline-grid");
      expect(control).toHaveStyle({ gridTemplateColumns: "7.5ch 1.25rem" });
    });

    const [shortControl, longControl] = controls as [HTMLElement, HTMLElement];
    expect(within(shortControl).getByRole("link", { name: "q-769" })).toHaveClass("justify-self-start");
    expect(within(shortControl).getByRole("button", { name: "Copy quest ID q-769" })).toHaveClass("justify-self-start");
    expect(within(longControl).getByRole("link", { name: "q-1153" })).toHaveClass("justify-self-start");
    expect(within(longControl).getByRole("button", { name: "Copy quest ID q-1153" })).toHaveClass("justify-self-start");
  });

  it("copies the quest id without activating the compact row", async () => {
    const quest = buildQuest();
    const onOpenQuest = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      <CompactQuestTable
        quests={[quest]}
        onOpenQuest={onOpenQuest}
        searchText=""
        journeyContextByQuestId={new Map()}
        sort={{ column: "updated", direction: "desc" }}
        sortSaving={false}
        onSortChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy quest ID q-100" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("q-100"));
    expect(onOpenQuest).not.toHaveBeenCalled();
  });
});
