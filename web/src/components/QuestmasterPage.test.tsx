// @vitest-environment jsdom
import { act, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { multiWordMatch, normalizeForSearch } from "../../shared/search-utils.js";
import type { QuestmasterTask } from "../types.js";

const mockCreateQuest = vi.fn();
const mockListQuestPage = vi.fn();
const mockGetSettings = vi.fn();
const mockUpdateSettings = vi.fn();
const mockUploadStandaloneQuestImage = vi.fn();
const mockClipboardWriteText = vi.fn();
let promptSpy: ReturnType<typeof vi.spyOn>;

vi.mock("../api.js", () => ({
  api: {
    createQuest: (...args: unknown[]) => mockCreateQuest(...args),
    listQuestPage: (...args: unknown[]) => mockListQuestPage(...args),
    getQuest: (questId: string) => Promise.resolve(mockState.quests.find((quest) => quest.questId === questId)),
    getSettings: (...args: unknown[]) => mockGetSettings(...args),
    updateSettings: (...args: unknown[]) => mockUpdateSettings(...args),
    uploadStandaloneQuestImage: (...args: unknown[]) => mockUploadStandaloneQuestImage(...args),
    questImageUrl: (id: string) => `/api/quests/_images/${id}`,
  },
}));

vi.mock("../utils/routing.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/routing.js")>();
  return {
    ...actual,
  };
});

vi.mock("../utils/questmaster-view-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/questmaster-view-state.js")>();
  return {
    VERIFICATION_INBOX_COLLAPSE_KEY: "verification_inbox",
    loadQuestmasterViewState: () => null,
    saveQuestmasterViewState: vi.fn(),
    toggleStatusFilter: actual.toggleStatusFilter,
  };
});

vi.mock("../utils/highlight.js", () => ({
  getHighlightParts: (text: string, query: string) => {
    if (!query) return [{ text, matched: false }];
    const index = text.toLowerCase().indexOf(query.toLowerCase());
    if (index < 0) return [{ text, matched: false }];
    return [
      { text: text.slice(0, index), matched: false },
      { text: text.slice(index, index + query.length), matched: true },
      { text: text.slice(index + query.length), matched: false },
    ].filter((part) => part.text.length > 0);
  },
}));

type MockStoreState = {
  quests: QuestmasterTask[];
  questsLoading: boolean;
  refreshQuests: ReturnType<typeof vi.fn>;
  setQuests: (quests: QuestmasterTask[]) => void;
  questOverlayId: string | null;
  questOverlaySearchHighlight: string | null;
  questmasterSearchQuery: string;
  questmasterSelectedTags: string[];
  questmasterViewMode: "cards" | "compact" | null;
  questmasterCompactSort: { column: string; direction: "asc" | "desc" } | null;
  setQuestmasterSearchQuery: ReturnType<typeof vi.fn>;
  setQuestmasterSelectedTags: ReturnType<typeof vi.fn>;
  setQuestmasterViewMode: ReturnType<typeof vi.fn>;
  setQuestmasterCompactSort: ReturnType<typeof vi.fn>;
  openQuestOverlay: ReturnType<typeof vi.fn>;
  closeQuestOverlay: ReturnType<typeof vi.fn>;
  replaceQuest: ReturnType<typeof vi.fn>;
  sessions: Map<string, unknown>;
  sessionPreviews: Map<string, unknown>;
  sessionTaskHistory: Map<string, unknown>;
  pendingPermissions: Map<string, unknown>;
  cliConnected: Map<string, boolean>;
  sessionStatus: Map<string, string>;
  askPermission: Map<string, unknown>;
  cliDisconnectReason: Map<string, unknown>;
  // Required by SessionNumChip (used in card header)
  sdkSessions: Array<{
    sessionId: string;
    state: string;
    cwd: string;
    createdAt: number;
    archived: boolean;
    sessionNum?: number;
    backendType?: string;
  }>;
  sessionNames: Map<string, string>;
  sessionBoards: Map<string, unknown[]>;
  sessionCompletedBoards: Map<string, unknown[]>;
  sessionBoardRowStatuses: Map<string, Record<string, import("../types.js").BoardRowSessionStatus>>;
  zoomLevel: number;
};

let mockState: MockStoreState;

type MockQuestPageOptions = {
  offset?: number;
  limit?: number;
  status?: string;
  tags?: string[];
  excludeTags?: string[];
  text?: string;
  sortColumn?: string;
  sortDirection?: "asc" | "desc";
};

type MockSearchRank = [number, number, number, number];

function buildVerificationQuest(input: {
  id: string;
  questId: string;
  title: string;
  verificationInboxUnread?: boolean;
}): QuestmasterTask {
  return {
    id: input.id,
    questId: input.questId,
    version: 3,
    title: input.title,
    createdAt: Date.now(),
    status: "done",
    description: "Needs review",
    sessionId: "session-1",
    claimedAt: Date.now(),
    completedAt: Date.now(),
    verificationItems: [{ text: "Verify behavior", checked: false }],
    verificationInboxUnread: input.verificationInboxUnread,
    tags: ["ui", "questmaster"],
    updatedAt: Date.now(),
    feedback: [
      {
        author: "human",
        text: "Please verify this behavior",
        ts: Date.now(),
        addressed: false,
      },
    ],
  } as QuestmasterTask;
}

function resetState(overrides: Partial<MockStoreState> = {}) {
  mockState = {
    quests: [],
    questsLoading: false,
    refreshQuests: vi.fn().mockResolvedValue(undefined),
    setQuests: (quests: QuestmasterTask[]) => {
      mockState.quests = quests;
    },
    questOverlayId: null,
    questOverlaySearchHighlight: null,
    questmasterSearchQuery: "",
    questmasterSelectedTags: [] as string[],
    questmasterViewMode: null as "cards" | "compact" | null,
    questmasterCompactSort: null,
    setQuestmasterSearchQuery: vi.fn((query: string) => {
      mockState.questmasterSearchQuery = query;
    }),
    setQuestmasterSelectedTags: vi.fn((tags: string[]) => {
      mockState.questmasterSelectedTags = tags;
    }),
    setQuestmasterViewMode: vi.fn((mode: "cards" | "compact") => {
      mockState.questmasterViewMode = mode;
    }),
    setQuestmasterCompactSort: vi.fn((sort: { column: string; direction: "asc" | "desc" }) => {
      mockState.questmasterCompactSort = sort;
    }),
    openQuestOverlay: vi.fn((questId: string, searchHighlight?: string) => {
      mockState.questOverlayId = questId;
      mockState.questOverlaySearchHighlight = searchHighlight ?? null;
    }),
    closeQuestOverlay: vi.fn(() => {
      mockState.questOverlayId = null;
      mockState.questOverlaySearchHighlight = null;
    }),
    replaceQuest: vi.fn(),
    sessions: new Map(),
    sessionPreviews: new Map(),
    sessionTaskHistory: new Map(),
    pendingPermissions: new Map(),
    cliConnected: new Map(),
    sessionStatus: new Map(),
    askPermission: new Map(),
    cliDisconnectReason: new Map(),
    sdkSessions: [],
    sessionNames: new Map(),
    sessionBoards: new Map(),
    sessionCompletedBoards: new Map(),
    sessionBoardRowStatuses: new Map(),
    zoomLevel: 1,
    ...overrides,
  };
}

function makeQuestPage(quests: QuestmasterTask[], offset = 0, limit = 50, countsSource = quests) {
  return {
    quests: quests.slice(offset, offset + limit),
    total: quests.length,
    offset,
    limit,
    hasMore: offset + limit < quests.length,
    nextOffset: offset + limit < quests.length ? offset + limit : null,
    previousOffset: offset > 0 ? Math.max(0, offset - limit) : null,
    counts: {
      all: countsSource.length,
      idea: countsSource.filter((quest) => quest.status === "idea").length,
      refined: countsSource.filter((quest) => quest.status === "refined").length,
      in_progress: countsSource.filter((quest) => quest.status === "in_progress").length,
      done: countsSource.filter((quest) => quest.status === "done").length,
    },
    allTags: getMockAllTags(),
  };
}

function getMockAllTags() {
  return Array.from(
    new Set(mockState.quests.flatMap((quest) => quest.tags ?? []).map((tag) => tag.toLowerCase())),
  ).sort((a, b) => a.localeCompare(b));
}

function makeMockQuestPage(options: MockQuestPageOptions = {}) {
  const withoutStatus = mockState.quests.filter((quest) => {
    if (options.tags?.length) {
      const questTags = new Set((quest.tags ?? []).map((tag) => tag.toLowerCase()));
      if (!options.tags.some((tag) => questTags.has(tag.toLowerCase()))) return false;
    }
    if (options.excludeTags?.length) {
      const questTags = new Set((quest.tags ?? []).map((tag) => tag.toLowerCase()));
      if (options.excludeTags.some((tag) => questTags.has(tag.toLowerCase()))) return false;
    }
    if (options.text && !getMockSearchRank(quest, options.text)) return false;
    return true;
  });
  const statuses = new Set(
    (options.status ?? "")
      .split(",")
      .map((status) => status.trim())
      .filter(Boolean),
  );
  const filtered = statuses.size === 0 ? withoutStatus : withoutStatus.filter((quest) => statuses.has(quest.status));
  return makeQuestPage(sortMockQuests(filtered, options), options.offset ?? 0, options.limit ?? 50, withoutStatus);
}

function sortMockQuests(quests: QuestmasterTask[], options: MockQuestPageOptions) {
  if (options.text?.trim()) {
    return quests
      .map((quest) => ({ quest, rank: getMockSearchRank(quest, options.text ?? "") }))
      .filter((entry): entry is { quest: QuestmasterTask; rank: MockSearchRank } => entry.rank !== null)
      .sort((left, right) => compareMockRank(left.rank, right.rank) || compareMockQuestIds(left.quest, right.quest))
      .map((entry) => entry.quest);
  }

  const column = options.sortColumn ?? "cards";
  const direction = options.sortDirection ?? (column === "cards" ? "asc" : "desc");
  return [...quests].sort((left, right) => {
    const columnResult = compareMockSortColumn(left, right, column);
    const directed = direction === "asc" ? columnResult : -columnResult;
    return directed || mockQuestRecencyTs(right) - mockQuestRecencyTs(left) || compareMockQuestIds(left, right);
  });
}

function compareMockSortColumn(left: QuestmasterTask, right: QuestmasterTask, column: string) {
  switch (column) {
    case "cards": {
      const statusOrder: Record<string, number> = { in_progress: 0, refined: 1, idea: 2, done: 3 };
      return (
        statusOrder[left.status] - statusOrder[right.status] || mockQuestRecencyTs(right) - mockQuestRecencyTs(left)
      );
    }
    case "quest":
      return compareMockQuestIds(left, right);
    case "title":
      return left.title.localeCompare(right.title, undefined, { numeric: true, sensitivity: "base" });
    case "updated":
      return mockQuestRecencyTs(left) - mockQuestRecencyTs(right);
    default:
      return 0;
  }
}

function getMockSearchRank(quest: QuestmasterTask, query: string): MockSearchRank | null {
  const fields = [
    { rank: 0, text: quest.questId },
    { rank: 1, text: quest.title },
    { rank: 2, text: quest.tldr },
    { rank: 3, text: "description" in quest ? quest.description : undefined },
    { rank: 4, text: quest.status === "done" && quest.cancelled !== true ? quest.debriefTldr : undefined },
    { rank: 5, text: quest.status === "done" && quest.cancelled !== true ? quest.debrief : undefined },
    ...("feedback" in quest
      ? (quest.feedback ?? []).flatMap((entry) => [
          { rank: 6, text: entry.tldr },
          { rank: 7, text: entry.text },
        ])
      : []),
  ];
  let best: MockSearchRank | null = null;
  for (const field of fields) {
    const rank = getMockFieldSearchRank(field.text, field.rank, query);
    if (!rank) continue;
    if (!best || compareMockRank(rank, best) < 0) best = rank;
  }
  return best;
}

function getMockFieldSearchRank(
  fieldText: string | undefined,
  fieldRank: number,
  query: string,
): MockSearchRank | null {
  if (!fieldText || !multiWordMatch(fieldText, query)) return null;
  const normalized = normalizeForSearch(fieldText);
  const normalizedQuery = normalizeForSearch(query);
  const words = normalizedQuery.split(/\s+/).filter(Boolean);
  const positions = words.map((word) => normalized.indexOf(word)).filter((index) => index >= 0);
  return [fieldRank, normalized.indexOf(normalizedQuery), Math.min(...positions), normalized.length];
}

function compareMockRank(left: MockSearchRank, right: MockSearchRank) {
  for (let index = 0; index < left.length; index += 1) {
    const diff = left[index] - right[index];
    if (diff !== 0) return diff;
  }
  return 0;
}

function compareMockQuestIds(left: QuestmasterTask, right: QuestmasterTask) {
  return left.questId.localeCompare(right.questId, undefined, { numeric: true, sensitivity: "base" });
}

function mockQuestRecencyTs(quest: QuestmasterTask) {
  return Math.max(quest.createdAt, quest.updatedAt ?? 0, quest.statusChangedAt ?? 0);
}

async function enterBackendSearch(input: HTMLElement, value: string, expectedText = value.trim()) {
  fireEvent.change(input, { target: { value } });
  await waitFor(() => {
    expect(mockListQuestPage).toHaveBeenLastCalledWith(expect.objectContaining({ text: expectedText }));
  });
}

vi.mock("../store.js", () => {
  const useStoreFn = (selector: (s: MockStoreState) => unknown) => selector(mockState);
  useStoreFn.getState = () => mockState;
  return {
    useStore: useStoreFn,
    countUserPermissions: () => 0,
  };
});

import { QuestmasterPage } from "./QuestmasterPage.js";

function renderQuestmaster(props: { isActive?: boolean } = {}) {
  return render(<QuestmasterPage isActive={false} {...props} />);
}

function compactRowQuestIds(): string[] {
  return screen
    .getAllByRole("button")
    .map((el) => el.getAttribute("data-quest-id"))
    .filter((questId): questId is string => !!questId);
}

function renderedQuestIds(): string[] {
  const compactRows = Array.from(document.querySelectorAll<HTMLElement>("tr[data-quest-id]"));
  const questElements =
    compactRows.length > 0 ? compactRows : Array.from(document.querySelectorAll<HTMLElement>("[data-quest-id]"));
  return questElements.map((el) => el.dataset.questId).filter((questId): questId is string => !!questId);
}

function clickLoadMore() {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent === "Load more",
  );
  if (!button) throw new Error("Load more button not found");
  fireEvent.click(button);
}

beforeEach(() => {
  vi.clearAllMocks();
  promptSpy = vi.spyOn(window, "prompt").mockReturnValue("");
  mockClipboardWriteText.mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText: mockClipboardWriteText } });
  const inboxQuest = buildVerificationQuest({
    id: "q-1-v3",
    questId: "q-1",
    title: "Fresh verification quest",
    verificationInboxUnread: true,
  });
  const regularQuest = buildVerificationQuest({
    id: "q-2-v3",
    questId: "q-2",
    title: "Regular verification quest",
    verificationInboxUnread: false,
  });
  resetState({
    quests: [inboxQuest, regularQuest],
  });
  mockListQuestPage.mockImplementation(async (options?: MockQuestPageOptions) => makeMockQuestPage(options));
  mockCreateQuest.mockImplementation(
    async (input: { title: string; description?: string; tags?: string[] }) =>
      ({
        id: "q-3-v1",
        questId: "q-3",
        version: 1,
        title: input.title,
        createdAt: Date.now(),
        status: "idea",
        description: input.description,
        tags: input.tags,
      }) as QuestmasterTask,
  );
  mockGetSettings.mockResolvedValue({
    questmasterViewMode: "cards",
    questmasterCompactSort: { column: "updated", direction: "desc" },
  });
  mockUpdateSettings.mockImplementation(
    async (input: {
      questmasterViewMode?: "cards" | "compact";
      questmasterCompactSort?: { column: string; direction: "asc" | "desc" };
    }) => ({
      questmasterViewMode: input.questmasterViewMode ?? mockState.questmasterViewMode ?? "cards",
      questmasterCompactSort: input.questmasterCompactSort ??
        mockState.questmasterCompactSort ?? { column: "updated", direction: "desc" },
    }),
  );
  mockUploadStandaloneQuestImage.mockResolvedValue({
    id: "img-upload",
    filename: "draft.png",
    mimeType: "image/png",
    path: "/tmp/draft.png",
  });
  window.location.hash = "#/questmaster";
});

afterEach(() => {
  promptSpy.mockRestore();
});

describe("QuestmasterPage status display", () => {
  it("renders verification quests under Completed without Review Inbox grouping", () => {
    // q-1034: verification remains visible, but inbox state is no longer a Questmaster grouping.
    renderQuestmaster({ isActive: true });

    expect(screen.queryByText("Review Inbox")).not.toBeInTheDocument();
    expect(screen.queryByText("Under Review")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Completed2$/ })).toBeInTheDocument();
    expect(screen.getByText("Fresh verification quest")).toBeInTheDocument();
    expect(screen.getByText("Regular verification quest")).toBeInTheDocument();
  });

  it("renders leader session attribution next to the worker owner", () => {
    const quest = {
      ...buildVerificationQuest({
        id: "q-50-v3",
        questId: "q-50",
        title: "Leader-routed quest",
        verificationInboxUnread: true,
      }),
      leaderSessionId: "leader-1",
    } as QuestmasterTask;
    resetState({
      quests: [quest],
      sdkSessions: [
        { sessionId: "session-1", state: "idle", cwd: "/repo", createdAt: 1, archived: false, sessionNum: 10 },
        { sessionId: "leader-1", state: "idle", cwd: "/repo", createdAt: 1, archived: false, sessionNum: 4 },
      ],
      sessionNames: new Map([
        ["session-1", "Worker"],
        ["leader-1", "Leader"],
      ]),
    });

    renderQuestmaster({ isActive: true });

    expect(screen.getByText("Leader-routed quest")).toBeInTheDocument();
    expect(screen.getByText("Leader")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "#10" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "#4" })).toBeInTheDocument();
  });

  it("collapses and expands the completed section without an inbox split", () => {
    // Completed remains a normal status group even when quests have verification metadata.
    renderQuestmaster({ isActive: true });

    const completedHeader = screen.getByRole("button", { name: /^Completed2$/ });
    expect(screen.getByText("Fresh verification quest")).toBeInTheDocument();

    fireEvent.click(completedHeader);
    expect(screen.queryByText("Fresh verification quest")).toBeNull();
    expect(screen.queryByText("Regular verification quest")).toBeNull();

    fireEvent.click(completedHeader);
    expect(screen.getByText("Fresh verification quest")).toBeInTheDocument();
    expect(screen.getByText("Regular verification quest")).toBeInTheDocument();
  });

  it("orders quests within a group by recency (updatedAt fallback to createdAt)", () => {
    const olderCreatedButRecentlyUpdated = {
      ...buildVerificationQuest({
        id: "q-10-v3",
        questId: "q-10",
        title: "Older create, newer update",
        verificationInboxUnread: false,
      }),
      createdAt: 1_000,
      updatedAt: 5_000,
      verificationInboxUnread: false,
    } as QuestmasterTask;
    const newerCreatedButNotUpdated = {
      ...buildVerificationQuest({
        id: "q-11-v3",
        questId: "q-11",
        title: "Newer create, older update",
        verificationInboxUnread: false,
      }),
      createdAt: 4_000,
      updatedAt: 4_000,
      verificationInboxUnread: false,
    } as QuestmasterTask;

    mockState.quests = [newerCreatedButNotUpdated, olderCreatedButRecentlyUpdated];
    renderQuestmaster({ isActive: true });

    const order = Array.from(document.querySelectorAll<HTMLElement>("[data-quest-id]")).map((el) => el.dataset.questId);
    expect(order).toEqual(["q-10", "q-11"]);
  });

  it("loads the server-persisted compact view and renders quests as dense rows", async () => {
    // View mode is a server setting: activating Questmaster should hydrate the compact table without localStorage.
    mockGetSettings.mockResolvedValueOnce({ questmasterViewMode: "compact" });

    renderQuestmaster({ isActive: true });

    expect(await screen.findAllByRole("columnheader", { name: "Quest" })).toHaveLength(1);
    expect(screen.getAllByRole("columnheader", { name: "Owner" })).toHaveLength(1);
    expect(screen.getAllByRole("columnheader", { name: "Leader" })).toHaveLength(1);
    expect(screen.getAllByRole("columnheader", { name: "Verify" })).toHaveLength(1);
    expect(screen.getAllByRole("table")).toHaveLength(1);
    expect(screen.queryByText("Review Inbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /q-1 Fresh verification quest/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /q-2 Regular verification quest/ })).toBeInTheDocument();
  });

  it("shows Completed status without inbox text while verification stays in the Verify column", async () => {
    // q-1034: status no longer encodes review inbox state; verification progress remains visible separately.
    mockGetSettings.mockResolvedValueOnce({ questmasterViewMode: "compact" });

    renderQuestmaster({ isActive: true });

    await screen.findByRole("button", { name: /q-1 Fresh verification quest/ });
    expect(screen.getAllByText("Completed").length).toBeGreaterThan(0);
    expect(screen.queryByText("Inbox")).not.toBeInTheDocument();
    expect(screen.getAllByText("0/1").length).toBeGreaterThan(0);
  });

  it("shows the active Journey phase as compact Status and opens the shared Journey hover card", async () => {
    mockGetSettings.mockResolvedValueOnce({ questmasterViewMode: "compact" });
    mockState.quests = [
      {
        ...buildVerificationQuest({ id: "q-88-v1", questId: "q-88", title: "Active Journey quest" }),
        status: "in_progress",
        sessionId: "worker-88",
        leaderSessionId: "leader-88",
      } as QuestmasterTask,
    ];
    mockState.sessionBoards = new Map([
      [
        "leader-88",
        [
          {
            questId: "q-88",
            title: "Active Journey quest",
            worker: "worker-88",
            workerNum: 88,
            status: "IMPLEMENTING",
            updatedAt: 10_000,
            journey: {
              mode: "active",
              phaseIds: ["alignment", "implement", "code-review"],
              currentPhaseId: "implement",
              activePhaseIndex: 1,
            },
          },
        ],
      ],
    ]);

    renderQuestmaster({ isActive: true });

    const row = await screen.findByRole("button", { name: /q-88 Active Journey quest/ });
    const status = within(row).getByText("Implement");
    expect(within(row).queryByText("In Progress")).not.toBeInTheDocument();

    fireEvent.mouseEnter(status);
    expect(await screen.findByTestId("quest-hover-journey")).toBeInTheDocument();
    expect(screen.getByTestId("quest-hover-status-row")).toHaveTextContent("Implement");
  });

  it("uses persisted Journey runs for compact Status and Status hover previews", async () => {
    mockGetSettings.mockResolvedValueOnce({ questmasterViewMode: "compact" });
    mockState.quests = [
      {
        ...buildVerificationQuest({ id: "q-89-v1", questId: "q-89", title: "Persisted Journey quest" }),
        status: "in_progress",
        journeyRuns: [
          {
            runId: "run-89",
            source: "board",
            phaseIds: ["alignment", "implement", "code-review"],
            status: "active",
            createdAt: 1,
            updatedAt: 2,
            workerSessionId: "worker-89",
            workerSessionNum: 89,
            phaseOccurrences: [
              {
                occurrenceId: "run-89:p1",
                phaseId: "alignment",
                phaseIndex: 0,
                phasePosition: 1,
                phaseOccurrence: 1,
                status: "completed",
                boardState: "PLANNING",
              },
              {
                occurrenceId: "run-89:p2",
                phaseId: "implement",
                phaseIndex: 1,
                phasePosition: 2,
                phaseOccurrence: 1,
                status: "active",
                boardState: "IMPLEMENTING",
              },
            ],
          },
        ],
      } as QuestmasterTask,
    ];

    renderQuestmaster({ isActive: true });

    const row = await screen.findByRole("button", { name: /q-89 Persisted Journey quest/ });
    const status = within(row).getByText("Implement");
    expect(within(row).queryByText("In Progress")).not.toBeInTheDocument();

    fireEvent.mouseEnter(status);
    expect(await screen.findByTestId("quest-hover-journey")).toBeInTheDocument();
  });

  it("keeps done quests Completed in compact Status despite stale Journey phase context", async () => {
    mockGetSettings.mockResolvedValueOnce({ questmasterViewMode: "compact" });
    mockState.quests = [
      {
        ...buildVerificationQuest({ id: "q-93-v1", questId: "q-93", title: "Done quest with stale board row" }),
        status: "done",
        sessionId: "worker-93",
        leaderSessionId: "leader-93",
      } as QuestmasterTask,
      {
        ...buildVerificationQuest({ id: "q-94-v1", questId: "q-94", title: "Done quest with stale run" }),
        status: "done",
        journeyRuns: [
          {
            runId: "run-94",
            source: "board",
            phaseIds: ["alignment", "implement", "code-review", "port"],
            status: "active",
            createdAt: 1,
            updatedAt: 2,
            workerSessionId: "worker-94",
            workerSessionNum: 94,
            phaseOccurrences: [
              {
                occurrenceId: "run-94:p4",
                phaseId: "port",
                phaseIndex: 3,
                phasePosition: 4,
                phaseOccurrence: 1,
                status: "active",
                boardState: "PORTING",
              },
            ],
          },
        ],
      } as QuestmasterTask,
    ];
    mockState.sessionBoards = new Map([
      [
        "leader-93",
        [
          {
            questId: "q-93",
            title: "Done quest with stale board row",
            worker: "worker-93",
            workerNum: 93,
            status: "PORTING",
            updatedAt: 10_000,
            journey: {
              mode: "active",
              phaseIds: ["alignment", "implement", "code-review", "port"],
              currentPhaseId: "port",
              activePhaseIndex: 3,
            },
          },
        ],
      ],
    ]);

    renderQuestmaster({ isActive: true });

    const staleBoardRow = await screen.findByRole("button", { name: /q-93 Done quest with stale board row/ });
    const staleBoardStatus = within(staleBoardRow).getByText("Completed");
    expect(staleBoardStatus).toBeInTheDocument();
    expect(within(staleBoardRow).queryByText("Port")).not.toBeInTheDocument();
    expect(within(staleBoardRow).getByText("0/1")).toBeInTheDocument();

    const staleRunRow = screen.getByRole("button", { name: /q-94 Done quest with stale run/ });
    expect(within(staleRunRow).getByText("Completed")).toBeInTheDocument();
    expect(within(staleRunRow).queryByText("Port")).not.toBeInTheDocument();
    expect(within(staleRunRow).getByText("0/1")).toBeInTheDocument();

    fireEvent.mouseEnter(staleBoardStatus);
    expect(await screen.findByTestId("quest-hover-journey")).toBeInTheDocument();
    expect(screen.getByTestId("quest-hover-status-row")).toHaveTextContent("Completed");
    expect(screen.getByTestId("quest-hover-status-row")).not.toHaveTextContent("Port");
    expect(screen.getByTestId("quest-hover-journey")).toHaveTextContent("Completed Journey");
  });

  it("limits compact title cells to title, tags, and one plain-text description TLDR string", async () => {
    mockGetSettings.mockResolvedValueOnce({ questmasterViewMode: "compact" });
    mockState.quests = [
      {
        ...buildVerificationQuest({ id: "q-90-v1", questId: "q-90", title: "Markdown TLDR quest" }),
        tldr: [
          "Use [q-986](quest:q-986) direction for the compact table.",
          "Keep this second line in the same truncated string instead of a second rendered line.",
        ].join("\n"),
        debriefTldr: "Debrief should not appear in compact title cells.",
        feedback: [
          {
            author: "agent",
            text: "Full phase summary should not appear in compact title cells.",
            tldr: "Phase summary should not appear.",
            ts: Date.now(),
            kind: "phase_summary",
            phaseId: "implement",
          },
        ],
      } as QuestmasterTask,
    ];

    renderQuestmaster({ isActive: true });

    const row = await screen.findByRole("button", { name: /q-90 Markdown TLDR quest/ });
    const tldr = within(row).getByTestId("quest-compact-tldr");
    expect(tldr).toHaveTextContent(
      "Use q-986 direction for the compact table. Keep this second line in the same truncated string instead of a second rendered line.",
    );
    expect(within(tldr).queryByRole("link", { name: "q-986" })).not.toBeInTheDocument();
    expect(within(row).getByText("#ui")).toBeInTheDocument();
    expect(within(row).getByText("#questmaster")).toBeInTheDocument();
    expect(within(row).queryByText(/Debrief should not appear/)).not.toBeInTheDocument();
    expect(within(row).queryByText(/Phase summary should not appear/)).not.toBeInTheDocument();
  });

  it("splits compact Owner and Leader into separate columns", async () => {
    mockGetSettings.mockResolvedValueOnce({ questmasterViewMode: "compact" });
    mockState.sdkSessions = [
      {
        sessionId: "worker-1347",
        sessionNum: 1347,
        state: "idle",
        cwd: "/tmp",
        createdAt: 1,
        archived: false,
      },
      {
        sessionId: "leader-1286",
        sessionNum: 1286,
        state: "idle",
        cwd: "/tmp",
        createdAt: 1,
        archived: false,
      },
    ];
    mockState.quests = [
      {
        ...buildVerificationQuest({ id: "q-91-v1", questId: "q-91", title: "Split owner leader quest" }),
        sessionId: "worker-1347",
        leaderSessionId: "leader-1286",
      } as QuestmasterTask,
    ];

    renderQuestmaster({ isActive: true });

    const row = await screen.findByRole("button", { name: /q-91 Split owner leader quest/ });
    const cells = row.querySelectorAll("td");
    expect(cells[2]).toHaveTextContent("#1347");
    expect(cells[2]).not.toHaveTextContent("Leader");
    expect(cells[2]).not.toHaveTextContent("#1286");
    expect(cells[3]).toHaveTextContent("#1286");
  });

  it("does not intercept keyboard activation on compact quest ID links", async () => {
    mockGetSettings.mockResolvedValueOnce({ questmasterViewMode: "compact" });
    mockState.quests = [
      {
        ...buildVerificationQuest({ id: "q-92-v1", questId: "q-92", title: "Quest ID link quest" }),
      } as QuestmasterTask,
    ];

    renderQuestmaster({ isActive: true });

    await screen.findByRole("button", { name: /q-92 Quest ID link quest/ });
    const questLink = screen.getByRole("link", { name: "q-92" });
    questLink.focus();
    expect(questLink).toHaveFocus();

    const enterEvent = createEvent.keyDown(questLink, { key: "Enter" });
    fireEvent(questLink, enterEvent);
    expect(enterEvent.defaultPrevented).toBe(false);

    const spaceEvent = createEvent.keyDown(questLink, { key: " " });
    fireEvent(questLink, spaceEvent);
    expect(spaceEvent.defaultPrevented).toBe(false);
    expect(mockState.openQuestOverlay).not.toHaveBeenCalled();
    expect(mockState.questOverlayId).toBeNull();

    fireEvent.click(questLink);
    expect(mockState.openQuestOverlay).toHaveBeenCalledWith("q-92");
    expect(mockState.questOverlayId).toBe("q-92");
  });

  it("pauses fallback polling while the tab is hidden and resumes on visibility", async () => {
    vi.useFakeTimers();
    let visibilityState: DocumentVisibilityState = "hidden";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });

    try {
      renderQuestmaster({ isActive: true });
      expect(mockListQuestPage).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(15_000);
      });
      expect(mockListQuestPage).toHaveBeenCalledTimes(1);

      visibilityState = "visible";
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(mockListQuestPage).toHaveBeenCalledTimes(2);

      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });
      expect(mockListQuestPage).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("debounces text search before calling the backend page API", async () => {
    // Typing should not issue one backend request per keystroke; the latest
    // search text is sent only after the Questmaster debounce interval.
    vi.useFakeTimers();
    try {
      renderQuestmaster({ isActive: true });
      await act(async () => {
        await Promise.resolve();
      });
      mockListQuestPage.mockClear();

      const searchInput = screen.getByPlaceholderText("Search or #tag...");
      fireEvent.change(searchInput, { target: { value: "q" } });
      await act(async () => {
        vi.advanceTimersByTime(499);
        await Promise.resolve();
      });
      expect(mockListQuestPage).not.toHaveBeenCalled();

      fireEvent.change(searchInput, { target: { value: "q-2" } });
      await act(async () => {
        vi.advanceTimersByTime(499);
        await Promise.resolve();
      });
      expect(mockListQuestPage).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(1);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockListQuestPage).toHaveBeenCalledTimes(1);
      expect(mockListQuestPage).toHaveBeenLastCalledWith(expect.objectContaining({ text: "q-2" }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("lazily loads later pages while keeping rendered compact rows bounded", async () => {
    // Loading more can browse past the first backend page, but the mounted list
    // should stay capped so long sessions do not rebuild hundreds of rows.
    mockGetSettings.mockResolvedValueOnce({
      questmasterViewMode: "compact",
      questmasterCompactSort: { column: "quest", direction: "asc" },
    });
    mockState.quests = Array.from({ length: 175 }, (_, index) => {
      const questNumber = index + 1;
      return {
        ...buildVerificationQuest({
          id: `q-${questNumber}-v1`,
          questId: `q-${questNumber}`,
          title: `Generated quest ${String(questNumber).padStart(3, "0")}`,
        }),
        status: "done",
        createdAt: questNumber,
        updatedAt: questNumber,
        verificationInboxUnread: false,
      } as QuestmasterTask;
    });

    renderQuestmaster({ isActive: true });

    await waitFor(() => {
      expect(mockListQuestPage).toHaveBeenLastCalledWith(
        expect.objectContaining({ offset: 0, limit: 50, sortColumn: "quest", sortDirection: "asc" }),
      );
      expect(renderedQuestIds()).toHaveLength(50);
      expect(renderedQuestIds()[0]).toBe("q-1");
    });

    clickLoadMore();
    await waitFor(() => {
      expect(mockListQuestPage).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 50, limit: 50 }));
      expect(renderedQuestIds()).toHaveLength(100);
      expect(renderedQuestIds()[99]).toBe("q-100");
    });

    clickLoadMore();
    await waitFor(() => {
      expect(mockListQuestPage).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 100, limit: 50 }));
      expect(renderedQuestIds()).toHaveLength(150);
      expect(renderedQuestIds()[149]).toBe("q-150");
    });

    clickLoadMore();
    await waitFor(() => {
      expect(mockListQuestPage).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 150, limit: 50 }));
      expect(renderedQuestIds()).toHaveLength(150);
      expect(renderedQuestIds()[0]).toBe("q-26");
      expect(renderedQuestIds()[149]).toBe("q-175");
      expect(screen.getByText("Showing 26-175 of 175")).toBeInTheDocument();
    });
  });

  it("orders compact rows by newest update without grouping by status", async () => {
    // Compact mode is one updated-time-sorted work-board-style table, independent of quest status buckets.
    mockGetSettings.mockResolvedValueOnce({ questmasterViewMode: "compact" });
    mockState.quests = [
      {
        ...buildVerificationQuest({ id: "q-20-v1", questId: "q-20", title: "Old verification" }),
        createdAt: 100,
        claimedAt: 100,
        statusChangedAt: 100,
        updatedAt: 1_000,
      } as QuestmasterTask,
      {
        ...buildVerificationQuest({ id: "q-21-v1", questId: "q-21", title: "Newest refined" }),
        status: "refined",
        createdAt: 200,
        statusChangedAt: 200,
        updatedAt: 9_000,
      } as QuestmasterTask,
      {
        ...buildVerificationQuest({ id: "q-22-v1", questId: "q-22", title: "Middle progress" }),
        status: "in_progress",
        createdAt: 300,
        claimedAt: 300,
        statusChangedAt: 300,
        updatedAt: 5_000,
      } as QuestmasterTask,
    ];

    renderQuestmaster({ isActive: true });

    await screen.findByRole("button", { name: /q-21 Newest refined/ });
    await waitFor(() => {
      expect(mockListQuestPage).toHaveBeenLastCalledWith(
        expect.objectContaining({ sortColumn: "updated", sortDirection: "desc" }),
      );
      expect(compactRowQuestIds()).toEqual(["q-21", "q-22", "q-20"]);
    });
    expect(screen.getAllByRole("table")).toHaveLength(1);
  });

  it("loads the server-persisted compact sort and applies it after default filtering", async () => {
    // The server-owned compact sort should hydrate with view mode and order the flat table.
    mockGetSettings.mockResolvedValueOnce({
      questmasterViewMode: "compact",
      questmasterCompactSort: { column: "title", direction: "asc" },
    });
    mockState.quests = [
      {
        ...buildVerificationQuest({ id: "q-40-v1", questId: "q-40", title: "Zulu task" }),
        status: "refined",
        updatedAt: 9_000,
      } as QuestmasterTask,
      {
        ...buildVerificationQuest({ id: "q-41-v1", questId: "q-41", title: "Alpha task" }),
        status: "refined",
        updatedAt: 1_000,
      } as QuestmasterTask,
    ];

    renderQuestmaster({ isActive: true });

    await screen.findByRole("button", { name: /q-41 Alpha task/ });
    await waitFor(() => {
      expect(mockListQuestPage).toHaveBeenLastCalledWith(
        expect.objectContaining({ sortColumn: "title", sortDirection: "asc" }),
      );
      expect(compactRowQuestIds()).toEqual(["q-41", "q-40"]);
    });
  });

  it("keeps compact column sorting when search is empty, then ranks non-empty searches by relevance", async () => {
    // Empty search should honor the selected compact sort, but typing a query
    // should lift the direct title match above weaker description matches.
    mockGetSettings.mockResolvedValueOnce({
      questmasterViewMode: "compact",
      questmasterCompactSort: { column: "title", direction: "asc" },
    });
    mockState.quests = [
      {
        ...buildVerificationQuest({
          id: "q-70-v1",
          questId: "q-70",
          title: "Position newly created quest tabs after Main",
        }),
        status: "done",
        description: "Direct title match should win once search is active.",
        updatedAt: 1_000,
      } as QuestmasterTask,
      {
        ...buildVerificationQuest({
          id: "q-71-v1",
          questId: "q-71",
          title: "Alpha background note",
        }),
        status: "in_progress",
        description: "Mentions new tab only in the description.",
        updatedAt: 9_000,
      } as QuestmasterTask,
    ];

    renderQuestmaster({ isActive: true });
    await screen.findByRole("button", { name: /q-71 Alpha background note/ });
    await waitFor(() => {
      expect(mockListQuestPage).toHaveBeenLastCalledWith(
        expect.objectContaining({ sortColumn: "title", sortDirection: "asc" }),
      );
      expect(compactRowQuestIds()).toEqual(["q-71", "q-70"]);
    });

    await enterBackendSearch(screen.getByPlaceholderText("Search or #tag..."), "new tab");

    expect(compactRowQuestIds()).toEqual(["q-70", "q-71"]);
  });

  it("toggles compact table headers, persists the choice, and updates row order", async () => {
    // Header buttons should advertise the next direction and save the selected sort server-side.
    mockGetSettings.mockResolvedValueOnce({
      questmasterViewMode: "compact",
      questmasterCompactSort: { column: "updated", direction: "desc" },
    });
    mockState.quests = [
      {
        ...buildVerificationQuest({ id: "q-50-v1", questId: "q-50", title: "Zulu task" }),
        status: "refined",
        updatedAt: 9_000,
      } as QuestmasterTask,
      {
        ...buildVerificationQuest({ id: "q-51-v1", questId: "q-51", title: "Alpha task" }),
        status: "refined",
        updatedAt: 1_000,
      } as QuestmasterTask,
    ];

    renderQuestmaster({ isActive: true });
    await screen.findByRole("button", { name: /q-50 Zulu task/ });

    fireEvent.click(screen.getByRole("button", { name: "Sort by Title ascending" }));

    await waitFor(() => {
      expect(mockUpdateSettings).toHaveBeenCalledWith({
        questmasterCompactSort: { column: "title", direction: "asc" },
      });
    });
    expect(compactRowQuestIds()).toEqual(["q-51", "q-50"]);

    fireEvent.click(screen.getByRole("button", { name: "Sort by Title descending" }));

    await waitFor(() => {
      expect(mockUpdateSettings).toHaveBeenLastCalledWith({
        questmasterCompactSort: { column: "title", direction: "desc" },
      });
    });
    expect(compactRowQuestIds()).toEqual(["q-50", "q-51"]);
  });

  it("filters first, then sorts compact rows by quest id numeric suffix", async () => {
    mockGetSettings.mockResolvedValueOnce({
      questmasterViewMode: "compact",
      questmasterCompactSort: { column: "quest", direction: "asc" },
    });
    mockState.quests = [
      {
        ...buildVerificationQuest({ id: "q-10-v1", questId: "q-10", title: "Keep later id" }),
        status: "refined",
      } as QuestmasterTask,
      {
        ...buildVerificationQuest({ id: "q-2-v1", questId: "q-2", title: "Keep early id" }),
        status: "refined",
      } as QuestmasterTask,
      {
        ...buildVerificationQuest({ id: "q-1-v1", questId: "q-1", title: "Drop this row" }),
        status: "refined",
      } as QuestmasterTask,
    ];

    renderQuestmaster({ isActive: true });
    await screen.findByRole("button", { name: /q-2 Keep early id/ });

    await enterBackendSearch(screen.getByPlaceholderText("Search or #tag..."), "Keep");

    expect(compactRowQuestIds()).toEqual(["q-2", "q-10"]);
    expect(screen.queryByRole("button", { name: /q-1 Drop this row/ })).toBeNull();
  });

  it("does not apply compact-table sort to Cards view", async () => {
    // Cards remain grouped and recency-sorted even when a compact sort preference exists.
    mockGetSettings.mockResolvedValueOnce({
      questmasterViewMode: "cards",
      questmasterCompactSort: { column: "title", direction: "asc" },
    });
    mockState.quests = [
      {
        ...buildVerificationQuest({ id: "q-60-v1", questId: "q-60", title: "Zulu newer card" }),
        status: "refined",
        updatedAt: 9_000,
      } as QuestmasterTask,
      {
        ...buildVerificationQuest({ id: "q-61-v1", questId: "q-61", title: "Alpha older card" }),
        status: "refined",
        updatedAt: 1_000,
      } as QuestmasterTask,
    ];

    renderQuestmaster({ isActive: true });

    await screen.findByText("Zulu newer card");
    expect(
      Array.from(document.querySelectorAll<HTMLElement>("[data-quest-id]")).map((el) => el.dataset.questId),
    ).toEqual(["q-60", "q-61"]);
    expect(screen.queryAllByRole("columnheader", { name: "Title" })).toHaveLength(0);
  });

  it("globally ranks card search results instead of preserving status section order", async () => {
    // Search should put the best match first across all statuses, so an older
    // done title match beats a newer in-progress description-only match.
    mockGetSettings.mockResolvedValueOnce({
      questmasterViewMode: "cards",
      questmasterCompactSort: { column: "updated", direction: "desc" },
    });
    mockState.quests = [
      {
        ...buildVerificationQuest({
          id: "q-80-v1",
          questId: "q-80",
          title: "Position newly created quest tabs after Main",
        }),
        status: "done",
        description: "Older card with direct title relevance.",
        updatedAt: 1_000,
      } as QuestmasterTask,
      {
        ...buildVerificationQuest({
          id: "q-81-v1",
          questId: "q-81",
          title: "Active implementation note",
        }),
        status: "in_progress",
        description: "Weaker new tab mention in body text.",
        updatedAt: 9_000,
      } as QuestmasterTask,
    ];

    renderQuestmaster({ isActive: true });
    await screen.findByText("Active implementation note");

    await enterBackendSearch(screen.getByPlaceholderText("Search or #tag..."), "new tab");

    expect(
      Array.from(document.querySelectorAll<HTMLElement>("[data-quest-id]")).map((el) => el.dataset.questId),
    ).toEqual(["q-80", "q-81"]);
  });

  it("applies the existing status dropdown filter to the flat compact table", async () => {
    mockGetSettings.mockResolvedValueOnce({ questmasterViewMode: "compact" });
    mockState.quests = [
      { ...buildVerificationQuest({ id: "q-30-v1", questId: "q-30", title: "Verification row" }) } as QuestmasterTask,
      {
        ...buildVerificationQuest({ id: "q-31-v1", questId: "q-31", title: "Refined row" }),
        status: "refined",
      } as QuestmasterTask,
    ];

    renderQuestmaster({ isActive: true });
    await screen.findByRole("button", { name: /q-30 Verification row/ });

    fireEvent.click(screen.getByRole("button", { name: /^All2/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Actionable1$/ }));

    await waitFor(() => {
      expect(mockListQuestPage).toHaveBeenLastCalledWith(expect.objectContaining({ status: "refined" }));
      expect(screen.queryByRole("button", { name: /q-30 Verification row/ })).toBeNull();
      expect(screen.getByRole("button", { name: /q-31 Refined row/ })).toBeInTheDocument();
    });
    expect(screen.getAllByRole("table")).toHaveLength(1);
  });

  it("saves the compact/cards toggle to server settings", async () => {
    // Toggling should PUT the preference to the server and immediately swap card list for table view.
    renderQuestmaster({ isActive: true });

    fireEvent.click(screen.getByRole("button", { name: "Compact" }));

    await waitFor(() => {
      expect(mockUpdateSettings).toHaveBeenCalledWith({ questmasterViewMode: "compact" });
    });
    expect(screen.getAllByRole("columnheader", { name: "Feedback" })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Cards" }));

    await waitFor(() => {
      expect(mockUpdateSettings).toHaveBeenLastCalledWith({ questmasterViewMode: "cards" });
    });
    expect(screen.queryAllByRole("columnheader", { name: "Feedback" })).toHaveLength(0);
  });

  it("opens quest overlay via store when clicking a compact row", async () => {
    // Clicking a compact row should set questOverlayId on the store so
    // QuestDetailPanel renders the detail modal globally.
    renderQuestmaster({ isActive: true });

    fireEvent.click(screen.getByRole("button", { name: "Compact" }));
    await screen.findAllByRole("columnheader", { name: "Quest" });

    fireEvent.click(screen.getByRole("button", { name: /q-1 Fresh verification quest/ }));

    expect(mockState.openQuestOverlay).toHaveBeenCalledWith("q-1", undefined);
    expect(mockState.questOverlayId).toBe("q-1");
  });

  it("copies the quest id from a card without opening the overlay", async () => {
    renderQuestmaster({ isActive: true });

    fireEvent.click(screen.getByRole("button", { name: "q-1" }));

    await waitFor(() => {
      expect(mockClipboardWriteText).toHaveBeenCalledWith("q-1");
    });
    expect(mockState.openQuestOverlay).not.toHaveBeenCalled();
    expect(mockState.questOverlayId).toBeNull();
    expect(screen.getByRole("button", { name: "Copied!" })).toBeInTheDocument();
  });

  it("opens compact quest id links with hover previews and copies from the adjacent icon", async () => {
    mockGetSettings.mockResolvedValueOnce({ questmasterViewMode: "compact" });

    renderQuestmaster({ isActive: true });
    await screen.findByRole("button", { name: /q-1 Fresh verification quest/ });

    const questLink = screen.getByRole("link", { name: "q-1" });
    fireEvent.mouseEnter(questLink);
    expect(await screen.findByTestId("quest-hover-card")).toBeInTheDocument();

    fireEvent.click(questLink);
    expect(mockState.openQuestOverlay).toHaveBeenCalledWith("q-1");
    expect(mockState.questOverlayId).toBe("q-1");

    mockState.openQuestOverlay.mockClear();
    mockState.questOverlayId = null;
    fireEvent.click(screen.getByRole("button", { name: "Copy quest ID q-1" }));

    await waitFor(() => {
      expect(mockClipboardWriteText).toHaveBeenCalledWith("q-1");
    });
    expect(mockState.openQuestOverlay).not.toHaveBeenCalled();
    expect(mockState.questOverlayId).toBeNull();
  });

  it("blocks compact row keyboard open when compact quest id controls are focused", async () => {
    mockGetSettings.mockResolvedValueOnce({ questmasterViewMode: "compact" });

    renderQuestmaster({ isActive: true });
    await screen.findByRole("button", { name: /q-1 Fresh verification quest/ });

    const questLink = screen.getByRole("link", { name: "q-1" });
    const copyButton = screen.getByRole("button", { name: "Copy quest ID q-1" });

    fireEvent.keyDown(questLink, { key: " " });
    expect(mockState.openQuestOverlay).not.toHaveBeenCalled();
    expect(mockState.questOverlayId).toBeNull();

    // JSDOM does not synthesize the native button click from Enter, so assert
    // the keydown does not bubble to the row, then emulate activation click.
    fireEvent.keyDown(copyButton, { key: "Enter" });
    expect(mockState.openQuestOverlay).not.toHaveBeenCalled();
    expect(mockState.questOverlayId).toBeNull();

    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(mockClipboardWriteText).toHaveBeenCalledWith("q-1");
    });
    expect(mockState.openQuestOverlay).not.toHaveBeenCalled();
    expect(mockState.questOverlayId).toBeNull();
  });

  it("opens compact rows even when their Cards-mode section is collapsed", async () => {
    // Compact view is flat: a previously-collapsed Cards group must not prevent overlay.
    renderQuestmaster({ isActive: true });

    fireEvent.click(screen.getByRole("button", { name: /^Completed2$/ }));
    expect(screen.queryByText("Fresh verification quest")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Compact" }));
    await screen.findByRole("button", { name: /q-1 Fresh verification quest/ });

    fireEvent.click(screen.getByRole("button", { name: /q-1 Fresh verification quest/ }));

    expect(mockState.questOverlayId).toBe("q-1");
  });

  it("opens quest overlay via deep-link", () => {
    // Deep-linking should open the targeted quest via the store overlay.
    window.location.hash = "#/questmaster?quest=q-2";
    renderQuestmaster({ isActive: true });

    expect(mockState.openQuestOverlay).toHaveBeenCalledWith("q-2");
    expect(mockState.questOverlayId).toBe("q-2");
  });

  it("cancels the pending deep-link scroll frame on unmount", () => {
    // The deep-link scroll is asynchronous; cleanup must cancel it so no
    // browser globals are touched after Vitest tears down jsdom.
    window.location.hash = "#/questmaster?quest=q-2";
    const requestFrameSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 123);
    const cancelFrameSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    try {
      const { unmount } = renderQuestmaster();
      unmount();

      expect(requestFrameSpy).toHaveBeenCalled();
      expect(cancelFrameSpy).toHaveBeenCalledWith(123);
    } finally {
      requestFrameSpy.mockRestore();
      cancelFrameSpy.mockRestore();
    }
  });

  it("highlights card with primary border when overlay is open for that quest", () => {
    // The card's appearance should reflect the overlay state from the store.
    mockState.questOverlayId = "q-1";
    renderQuestmaster({ isActive: true });

    const card = document.querySelector('[data-quest-id="q-1"]');
    expect(card).toBeTruthy();
    expect(card!.className).toContain("border-cc-primary");
  });

  it("filters quests by quest id from the search box", async () => {
    // Questmaster search should support direct quest-id lookup so users can
    // jump to a known quest like q-2 without remembering the title text.
    renderQuestmaster({ isActive: true });

    const searchInput = screen.getByPlaceholderText("Search or #tag...");

    await enterBackendSearch(searchInput, "q-2");
    expect(screen.getByText("Regular verification quest")).toBeInTheDocument();
    expect(screen.queryByText("Fresh verification quest")).toBeNull();

    await enterBackendSearch(searchInput, "Q-1");
    expect(screen.getByText("Fresh verification quest")).toBeInTheDocument();
    expect(screen.queryByText("Regular verification quest")).toBeNull();
  });

  it("filters by TLDR and full feedback text when feedback has TLDR metadata", async () => {
    // TLDR should improve visible scan text without making the detailed body unsearchable.
    mockState.quests = [
      {
        ...buildVerificationQuest({ id: "q-30-v1", questId: "q-30", title: "TLDR quest" }),
        tldr: "Short scanline",
        feedback: [{ author: "agent", text: "Full implementation detail", tldr: "Short handoff", ts: Date.now() }],
      } as QuestmasterTask,
      {
        ...buildVerificationQuest({ id: "q-31-v1", questId: "q-31", title: "Other quest" }),
        verificationInboxUnread: false,
      } as QuestmasterTask,
    ];

    renderQuestmaster({ isActive: true });

    const searchInput = screen.getByPlaceholderText("Search or #tag...");
    await enterBackendSearch(searchInput, "scanline");
    expect(document.querySelector('[data-quest-id="q-30"]')).toBeTruthy();
    expect(document.querySelector('[data-quest-id="q-31"]')).toBeNull();

    await enterBackendSearch(searchInput, "implementation");
    expect(document.querySelector('[data-quest-id="q-30"]')).toBeTruthy();
    expect(document.querySelector('[data-quest-id="q-31"]')).toBeNull();
  });

  it("shows phase TLDR scan lines in quest list results", () => {
    mockState.quests = [
      {
        ...buildVerificationQuest({ id: "q-40-v1", questId: "q-40", title: "Phase documented quest" }),
        journeyRuns: [
          {
            runId: "run-1",
            source: "board",
            phaseIds: ["alignment", "implement"],
            status: "completed",
            createdAt: 1,
            updatedAt: 2,
            phaseOccurrences: [
              {
                occurrenceId: "run-1:p1",
                phaseId: "alignment",
                phaseIndex: 0,
                phasePosition: 1,
                phaseOccurrence: 1,
                status: "completed",
              },
              {
                occurrenceId: "run-1:p2",
                phaseId: "implement",
                phaseIndex: 1,
                phasePosition: 2,
                phaseOccurrence: 1,
                status: "completed",
              },
            ],
          },
        ],
        feedback: [
          {
            author: "agent",
            text: "Full implementation detail should stay out of the compact list.",
            tldr: "Implementation phase scanline.",
            ts: Date.now(),
            journeyRunId: "run-1",
            phaseOccurrenceId: "run-1:p2",
            phaseId: "implement",
            phasePosition: 2,
          },
        ],
      } as QuestmasterTask,
    ];

    renderQuestmaster({ isActive: true });

    expect(screen.getByText(/Implement phase 2:/)).toBeInTheDocument();
    expect(screen.getByText(/Implementation phase scanline/)).toBeInTheDocument();
    expect(screen.queryByText(/Full implementation detail should stay out/)).toBeNull();
  });

  it("preserves plain-text title search while ignoring negated-tag syntax", async () => {
    // q-331: plain-text matching should remain intact after introducing
    // explicit `-#tag` exclusion parsing.
    mockState.quests = [
      {
        ...buildVerificationQuest({ id: "q-40-v1", questId: "q-40", title: "Auth mobile quest" }),
        verificationInboxUnread: false,
        tags: ["auth", "mobile"],
      } as QuestmasterTask,
      {
        ...buildVerificationQuest({ id: "q-41-v1", questId: "q-41", title: "Infra backend quest" }),
        verificationInboxUnread: false,
        tags: ["infra", "backend"],
      } as QuestmasterTask,
    ];

    renderQuestmaster({ isActive: true });

    const searchInput = screen.getByPlaceholderText("Search or #tag...");
    await enterBackendSearch(searchInput, "backend");

    expect(document.querySelector('[data-quest-id="q-41"]')).toBeTruthy();
    expect(document.querySelector('[data-quest-id="q-40"]')).toBeNull();
  });

  it("preserves positive #tag search through the existing autocomplete tag-pill flow", async () => {
    // Positive #tag search should keep working exactly as before: selecting an
    // autocomplete tag turns it into a pill and filters by matching quests.
    mockState.quests = [
      {
        ...buildVerificationQuest({ id: "q-50-v1", questId: "q-50", title: "Auth mobile quest" }),
        verificationInboxUnread: false,
        tags: ["auth", "mobile"],
      } as QuestmasterTask,
      {
        ...buildVerificationQuest({ id: "q-51-v1", questId: "q-51", title: "Auth backend quest" }),
        verificationInboxUnread: false,
        tags: ["auth", "backend"],
      } as QuestmasterTask,
      {
        ...buildVerificationQuest({ id: "q-52-v1", questId: "q-52", title: "Infra mobile quest" }),
        verificationInboxUnread: false,
        tags: ["infra", "mobile"],
      } as QuestmasterTask,
    ];

    renderQuestmaster({ isActive: true });

    const searchInput = screen.getByPlaceholderText("Search or #tag...");
    fireEvent.change(searchInput, { target: { value: "#mob" } });
    fireEvent.keyDown(searchInput, { key: "Enter" });

    expect(screen.getByText("#mobile")).toBeInTheDocument();
    await waitFor(() => {
      expect(mockListQuestPage).toHaveBeenLastCalledWith(expect.objectContaining({ tags: ["mobile"] }));
      expect(screen.getByText("Auth mobile quest")).toBeInTheDocument();
      expect(screen.getByText("Infra mobile quest")).toBeInTheDocument();
      expect(screen.queryByText("Auth backend quest")).toBeNull();
    });
  });

  it("supports bare # as the positive-tag autocomplete entry path", () => {
    // q-331 follow-up: typing a bare `#` should still open the positive-tag
    // suggestions so users can enter the existing #tag pill flow without
    // typing a tag prefix first.
    mockState.quests = [
      {
        ...buildVerificationQuest({ id: "q-55-v1", questId: "q-55", title: "Alpha quest" }),
        verificationInboxUnread: false,
        tags: ["alpha"],
      } as QuestmasterTask,
      {
        ...buildVerificationQuest({ id: "q-56-v1", questId: "q-56", title: "Beta quest" }),
        verificationInboxUnread: false,
        tags: ["beta"],
      } as QuestmasterTask,
    ];

    renderQuestmaster({ isActive: true });

    const searchInput = screen.getByPlaceholderText("Search or #tag...") as HTMLInputElement;
    fireEvent.focus(searchInput);
    fireEvent.change(searchInput, { target: { value: "#" } });
    fireEvent.keyDown(searchInput, { key: "Enter" });

    expect(screen.getByText("#alpha")).toBeInTheDocument();
    expect(searchInput.value).toBe("");
  });

  it("shows an excluding hint and keeps negated autocomplete in the raw query", () => {
    // The clearer negated syntax uses `!#tag`. While typing it, the dropdown
    // should hint that the user is excluding a tag and selecting an option
    // should keep that negated token in the raw query instead of creating a
    // positive tag pill.
    mockState.quests = [
      {
        ...buildVerificationQuest({ id: "q-57-v1", questId: "q-57", title: "Alpha quest" }),
        verificationInboxUnread: false,
        tags: ["alpha"],
      } as QuestmasterTask,
      {
        ...buildVerificationQuest({ id: "q-58-v1", questId: "q-58", title: "Beta quest" }),
        verificationInboxUnread: false,
        tags: ["beta"],
      } as QuestmasterTask,
    ];

    renderQuestmaster({ isActive: true });

    const searchInput = screen.getByPlaceholderText("Search or #tag...") as HTMLInputElement;
    fireEvent.focus(searchInput);
    fireEvent.change(searchInput, { target: { value: "!#" } });

    expect(screen.getByText("excluding:")).toBeInTheDocument();
    fireEvent.keyDown(searchInput, { key: "Enter" });

    expect(searchInput.value).toBe("!#alpha");
    expect(screen.queryByText("#alpha")).toBeNull();
  });

  it("supports -#tag to exclude quests with matching tags", async () => {
    // q-331: the search box should support explicit negated tags that exclude
    // matching quests without requiring users to mutate the positive tag pills.
    mockState.quests = [
      {
        ...buildVerificationQuest({ id: "q-60-v1", questId: "q-60", title: "Auth mobile quest" }),
        verificationInboxUnread: false,
        tags: ["auth", "mobile"],
      } as QuestmasterTask,
      {
        ...buildVerificationQuest({ id: "q-61-v1", questId: "q-61", title: "Auth backend quest" }),
        verificationInboxUnread: false,
        tags: ["auth", "backend"],
      } as QuestmasterTask,
      {
        ...buildVerificationQuest({ id: "q-62-v1", questId: "q-62", title: "Infra mobile quest" }),
        verificationInboxUnread: false,
        tags: ["infra", "mobile"],
      } as QuestmasterTask,
    ];

    renderQuestmaster({ isActive: true });

    const searchInput = screen.getByPlaceholderText("Search or #tag...");
    fireEvent.change(searchInput, { target: { value: "!#mobile" } });
    await waitFor(() => {
      expect(mockListQuestPage).toHaveBeenLastCalledWith(expect.objectContaining({ excludeTags: ["mobile"] }));
    });

    expect(document.querySelector('[data-quest-id="q-61"]')).toBeTruthy();
    expect(document.querySelector('[data-quest-id="q-60"]')).toBeNull();
    expect(document.querySelector('[data-quest-id="q-62"]')).toBeNull();
  });

  it("does not convert negated hashtags into positive tag pills via autocomplete", () => {
    // Negated tags should stay in the raw search query. Hitting Enter on `!#mob`
    // must not create the positive `#mobile` tag pill or clear the search text.
    mockState.quests = [
      {
        ...buildVerificationQuest({ id: "q-65-v1", questId: "q-65", title: "Auth mobile quest" }),
        verificationInboxUnread: false,
        tags: ["auth", "mobile"],
      } as QuestmasterTask,
      {
        ...buildVerificationQuest({ id: "q-66-v1", questId: "q-66", title: "Infra backend quest" }),
        verificationInboxUnread: false,
        tags: ["infra", "backend"],
      } as QuestmasterTask,
    ];

    renderQuestmaster();

    const searchInput = screen.getByPlaceholderText("Search or #tag...") as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: "!#mob" } });
    fireEvent.keyDown(searchInput, { key: "Enter" });

    expect(searchInput.value).toBe("!#mobile");
    expect(screen.queryByText("#mobile")).toBeNull();
  });

  it("treats numeric-leading hashtag tokens as plain text search", async () => {
    // Session-style references like #123 should remain searchable literal text
    // instead of being stripped as tag syntax or turned into tag autocomplete.
    mockState.quests = [
      {
        ...buildVerificationQuest({ id: "q-67-v1", questId: "q-67", title: "Follow up on #123 reconnect report" }),
        verificationInboxUnread: false,
        tags: ["alpha"],
      } as QuestmasterTask,
      {
        ...buildVerificationQuest({ id: "q-68-v1", questId: "q-68", title: "Follow up on #456 reconnect report" }),
        verificationInboxUnread: false,
        tags: ["alpha"],
      } as QuestmasterTask,
    ];

    renderQuestmaster({ isActive: true });

    const searchInput = screen.getByPlaceholderText("Search or #tag...");
    await enterBackendSearch(searchInput, "#123");

    expect(document.querySelector('[data-quest-id="q-67"]')).toBeTruthy();
    expect(document.querySelector('[data-quest-id="q-68"]')).toBeNull();
    expect(screen.queryByText("excluding:")).toBeNull();
  });

  it("supports mixed free-text plus negated-tag queries and only highlights the positive text", async () => {
    // Mixed queries like `auth !#mobile` should preserve the positive text
    // match while excluding the negated tag, and highlight only the positive
    // free-text portion of the query.
    mockState.quests = [
      {
        ...buildVerificationQuest({ id: "q-70-v1", questId: "q-70", title: "Auth mobile quest" }),
        verificationInboxUnread: false,
        tags: ["auth", "mobile"],
      } as QuestmasterTask,
      {
        ...buildVerificationQuest({ id: "q-71-v1", questId: "q-71", title: "Auth backend quest" }),
        verificationInboxUnread: false,
        tags: ["auth", "backend"],
      } as QuestmasterTask,
      {
        ...buildVerificationQuest({ id: "q-72-v1", questId: "q-72", title: "Infra backend quest" }),
        verificationInboxUnread: false,
        tags: ["infra", "backend"],
      } as QuestmasterTask,
    ];

    const { container } = renderQuestmaster({ isActive: true });

    const searchInput = screen.getByPlaceholderText("Search or #tag...");
    await enterBackendSearch(searchInput, "auth !#mobile", "auth");

    expect(document.querySelector('[data-quest-id="q-71"]')).toBeTruthy();
    expect(document.querySelector('[data-quest-id="q-70"]')).toBeNull();
    expect(document.querySelector('[data-quest-id="q-72"]')).toBeNull();

    const marks = Array.from(container.querySelectorAll("mark")).map((el) => el.textContent?.toLowerCase());
    expect(marks).toContain("auth");
    expect(marks).not.toContain("mobile");
  });

  it("supports mixed positive #tag pills plus negated-tag queries", async () => {
    // Users should be able to select a positive tag via the existing pill flow
    // and then further narrow the result with a raw `!#tag` exclusion query.
    mockState.quests = [
      {
        ...buildVerificationQuest({ id: "q-80-v1", questId: "q-80", title: "Auth mobile quest" }),
        verificationInboxUnread: false,
        tags: ["auth", "mobile"],
      } as QuestmasterTask,
      {
        ...buildVerificationQuest({ id: "q-81-v1", questId: "q-81", title: "Auth backend quest" }),
        verificationInboxUnread: false,
        tags: ["auth", "backend"],
      } as QuestmasterTask,
      {
        ...buildVerificationQuest({ id: "q-82-v1", questId: "q-82", title: "Infra mobile quest" }),
        verificationInboxUnread: false,
        tags: ["infra", "mobile"],
      } as QuestmasterTask,
    ];

    renderQuestmaster({ isActive: true });

    const searchInput = screen.getByPlaceholderText("Search or #tag...");
    fireEvent.change(searchInput, { target: { value: "#auth" } });
    fireEvent.keyDown(searchInput, { key: "Enter" });
    expect(screen.getByText("#auth")).toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: "!#backend" } });

    await waitFor(() => {
      expect(mockListQuestPage).toHaveBeenLastCalledWith(
        expect.objectContaining({ tags: ["auth"], excludeTags: ["backend"] }),
      );
      expect(document.querySelector('[data-quest-id="q-80"]')).toBeTruthy();
      expect(document.querySelector('[data-quest-id="q-81"]')).toBeNull();
      expect(document.querySelector('[data-quest-id="q-82"]')).toBeNull();
    });
  });

  it("passes only the positive/free-text portion of a mixed negated query into the quest overlay", () => {
    // The detail overlay highlight should reuse the parsed positive search text,
    // not the raw query with `!#tag` suffixes.
    mockState.quests = [
      {
        ...buildVerificationQuest({ id: "q-90-v1", questId: "q-90", title: "Auth mobile quest" }),
        verificationInboxUnread: false,
        tags: ["auth", "mobile"],
      } as QuestmasterTask,
      {
        ...buildVerificationQuest({ id: "q-91-v1", questId: "q-91", title: "Auth backend quest" }),
        verificationInboxUnread: false,
        tags: ["auth", "backend"],
      } as QuestmasterTask,
    ];

    renderQuestmaster();

    const searchInput = screen.getByPlaceholderText("Search or #tag...");
    fireEvent.change(searchInput, { target: { value: "auth !#mobile" } });

    const cardButton = document.querySelector('[data-quest-id="q-91"] [role="button"]') as HTMLElement | null;
    expect(cardButton).toBeTruthy();
    fireEvent.click(cardButton!);

    expect(mockState.openQuestOverlay).toHaveBeenCalledWith("q-91", "auth");
  });

  it("opens quest overlay for newly created quest", async () => {
    // After creating a quest, openQuestOverlay should be called with the new quest's ID.
    renderQuestmaster();

    fireEvent.click(screen.getByRole("button", { name: /New Quest/i }));
    fireEvent.change(screen.getByPlaceholderText("Quest title"), {
      target: { value: "Investigate reconnect jitter" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(mockCreateQuest).toHaveBeenCalledWith({
        title: "Investigate reconnect jitter",
        description: undefined,
        tags: undefined,
        images: undefined,
      });
    });
    await waitFor(() => {
      expect(mockState.questOverlayId).toBe("q-3");
    });
    // Note: the real component dismisses the create form when questOverlayId
    // becomes non-null, but the mock store isn't reactive so the component
    // doesn't re-render here. The important assertion (overlay ID) is above.
  });

  it("keeps the New Quest title field out of textarea auto-resize work", () => {
    // The typing-latency fix relies on the title being a single-line input
    // inside a paint/layout containment boundary instead of resizing a
    // textarea above the full Questmaster list on every keystroke.
    renderQuestmaster();

    fireEvent.click(screen.getByRole("button", { name: /New Quest/i }));

    expect(screen.getByTestId("questmaster-create-form")).toHaveStyle({ contain: "layout paint style" });
    expect(screen.getByPlaceholderText("Quest title").tagName).toBe("INPUT");
  });

  it("preserves New Quest drafts across hide and reopen paths", async () => {
    // The create form stays mounted while hidden, so draft text/images survive
    // incidental closes without returning typing state to the full page.
    renderQuestmaster();

    fireEvent.click(screen.getByRole("button", { name: /New Quest/i }));
    const titleInput = screen.getByPlaceholderText("Quest title");
    const descriptionInput = screen.getByPlaceholderText("Description (optional)");
    fireEvent.change(titleInput, { target: { value: "Draft reconnect follow-up" } });
    fireEvent.change(descriptionInput, { target: { value: "Keep this draft through closes." } });

    const fileInput = document.querySelector('input[type="file"][accept="image/*"]') as HTMLInputElement | null;
    expect(fileInput).not.toBeNull();
    const file = new File(["quest-image"], "draft.png", { type: "image/png" });
    fireEvent.change(fileInput!, { target: { files: [file] } });
    expect(await screen.findByAltText("draft.png")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /New Quest/i }));
    expect(screen.getByTestId("questmaster-create-form")).toHaveClass("hidden");

    fireEvent.click(screen.getByRole("button", { name: /New Quest/i }));
    expect(screen.getByPlaceholderText("Quest title")).toHaveValue("Draft reconnect follow-up");
    expect(screen.getByPlaceholderText("Description (optional)")).toHaveValue("Keep this draft through closes.");
    expect(screen.getByAltText("draft.png")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByPlaceholderText("Quest title"), { key: "Escape" });
    expect(screen.getByTestId("questmaster-create-form")).toHaveClass("hidden");

    fireEvent.click(screen.getByRole("button", { name: /New Quest/i }));
    expect(screen.getByPlaceholderText("Quest title")).toHaveValue("Draft reconnect follow-up");
    expect(screen.getByPlaceholderText("Description (optional)")).toHaveValue("Keep this draft through closes.");
    expect(screen.getByAltText("draft.png")).toBeInTheDocument();

    act(() => {
      window.location.hash = "#/questmaster?quest=q-1";
      window.dispatchEvent(new Event("hashchange"));
    });
    await waitFor(() => expect(screen.getByTestId("questmaster-create-form")).toHaveClass("hidden"));

    fireEvent.click(screen.getByRole("button", { name: /New Quest/i }));
    expect(screen.getByPlaceholderText("Quest title")).toHaveValue("Draft reconnect follow-up");
    expect(screen.getByPlaceholderText("Description (optional)")).toHaveValue("Keep this draft through closes.");
    expect(screen.getByAltText("draft.png")).toBeInTheDocument();
  });

  it("preserves New Quest draft text but clears draft images on Cancel", async () => {
    // Preserve the pre-extraction behavior: Cancel hid the form and cleared
    // uploaded draft images, while title/description draft text stayed around.
    renderQuestmaster();

    fireEvent.click(screen.getByRole("button", { name: /New Quest/i }));
    fireEvent.change(screen.getByPlaceholderText("Quest title"), { target: { value: "Cancel-safe draft" } });
    fireEvent.change(screen.getByPlaceholderText("Description (optional)"), {
      target: { value: "Text should remain after Cancel." },
    });

    const fileInput = document.querySelector('input[type="file"][accept="image/*"]') as HTMLInputElement | null;
    expect(fileInput).not.toBeNull();
    const file = new File(["quest-image"], "cancel-cleared.png", { type: "image/png" });
    fireEvent.change(fileInput!, { target: { files: [file] } });
    expect(await screen.findByAltText("draft.png")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("questmaster-create-form")).toHaveClass("hidden");

    fireEvent.click(screen.getByRole("button", { name: /New Quest/i }));
    expect(screen.getByPlaceholderText("Quest title")).toHaveValue("Cancel-safe draft");
    expect(screen.getByPlaceholderText("Description (optional)")).toHaveValue("Text should remain after Cancel.");
    expect(screen.queryByAltText("draft.png")).not.toBeInTheDocument();
  });

  it("does not extract numeric-leading session references as quest tags on create", async () => {
    // Numeric-leading references like #123 often point to sessions, so create
    // flow extraction should keep them out of the saved tag list.
    renderQuestmaster();

    fireEvent.click(screen.getByRole("button", { name: /New Quest/i }));
    fireEvent.change(screen.getByPlaceholderText("Quest title"), {
      target: { value: "Follow session #123 and tag #alpha" },
    });
    fireEvent.change(screen.getByPlaceholderText("Description (optional)"), {
      target: { value: "Need context from #456 before #beta ships." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(mockCreateQuest).toHaveBeenCalledWith({
        title: "Follow session #123 and tag #alpha",
        description: "Need context from #456 before #beta ships.",
        tags: ["alpha", "beta"],
        images: undefined,
      });
    });
  });

  it("opens create-form image previews in a lightbox instead of a new tab", async () => {
    renderQuestmaster();
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    fireEvent.click(screen.getByRole("button", { name: /New Quest/i }));

    const fileInput = document.querySelector('input[type="file"][accept="image/*"]') as HTMLInputElement | null;
    expect(fileInput).not.toBeNull();

    const file = new File(["quest-image"], "draft.png", { type: "image/png" });
    fireEvent.change(fileInput!, { target: { files: [file] } });

    await waitFor(() => {
      expect(mockUploadStandaloneQuestImage).toHaveBeenCalledWith(file);
    });

    fireEvent.click(await screen.findByAltText("draft.png"));

    expect(openSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId("lightbox-image")).toHaveAttribute("src", "/api/quests/_images/img-upload");

    openSpy.mockRestore();
  });

  it("toggles quest overlay closed when clicking an already-expanded quest card", () => {
    // Clicking the same quest card again should close the overlay.
    mockState.questOverlayId = "q-1";
    renderQuestmaster();

    fireEvent.click(screen.getByText("Fresh verification quest"));

    expect(mockState.closeQuestOverlay).toHaveBeenCalled();
    expect(mockState.questOverlayId).toBeNull();
  });
});
