// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { multiWordMatch } from "../../shared/search-utils.js";
import type { QuestmasterTask, QuestStatus } from "../types.js";

const mockCreateQuest = vi.fn();
const mockListQuestPage = vi.fn();
const mockGetSettings = vi.fn();
const mockUpdateSettings = vi.fn();
const mockUploadStandaloneQuestImage = vi.fn();

vi.mock("../api.js", () => ({
  api: {
    createQuest: (...args: unknown[]) => mockCreateQuest(...args),
    listQuestPage: (...args: unknown[]) => mockListQuestPage(...args),
    getQuest: (questId: string) =>
      Promise.resolve(mockState.quests.find((quest: QuestmasterTask) => quest.questId === questId)),
    getSettings: (...args: unknown[]) => mockGetSettings(...args),
    updateSettings: (...args: unknown[]) => mockUpdateSettings(...args),
    uploadStandaloneQuestImage: (...args: unknown[]) => mockUploadStandaloneQuestImage(...args),
    questImageUrl: (id: string) => `/api/quests/_images/${id}`,
  },
}));

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

let mockState: any;

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

function makeQuest(input: {
  questId: string;
  title: string;
  status?: QuestStatus;
  createdAt?: number;
  updatedAt?: number;
  tags?: string[];
  description?: string;
}): QuestmasterTask {
  return {
    id: `${input.questId}-v1`,
    questId: input.questId,
    version: 1,
    title: input.title,
    createdAt: input.createdAt ?? 1,
    updatedAt: input.updatedAt,
    status: input.status ?? "idea",
    description: input.description ?? "",
    tags: input.tags,
  } as QuestmasterTask;
}

function resetState(overrides: Record<string, unknown> = {}) {
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
    questmasterSelectedTags: [],
    questmasterViewMode: null,
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
    closeQuestOverlay: vi.fn(),
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

function makeMockQuestPage(options: MockQuestPageOptions = {}) {
  const withoutStatus = mockState.quests.filter((quest: QuestmasterTask) => {
    const questTags = new Set((quest.tags ?? []).map((tag) => tag.toLowerCase()));
    if (options.tags?.length && !options.tags.some((tag) => questTags.has(tag.toLowerCase()))) return false;
    if (options.excludeTags?.length && options.excludeTags.some((tag) => questTags.has(tag.toLowerCase())))
      return false;
    if (options.text && !multiWordMatch(`${quest.questId}\n${quest.title}\n${quest.description ?? ""}`, options.text))
      return false;
    return true;
  });
  const statuses = new Set(
    (options.status ?? "")
      .split(",")
      .map((status) => status.trim())
      .filter(Boolean),
  );
  const filtered =
    statuses.size === 0 ? withoutStatus : withoutStatus.filter((quest: QuestmasterTask) => statuses.has(quest.status));
  const sorted = sortMockQuests(filtered, options);
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 50;
  return {
    quests: sorted.slice(offset, offset + limit),
    total: sorted.length,
    offset,
    limit,
    hasMore: offset + limit < sorted.length,
    nextOffset: offset + limit < sorted.length ? offset + limit : null,
    previousOffset: offset > 0 ? Math.max(0, offset - limit) : null,
    counts: {
      all: withoutStatus.length,
      idea: withoutStatus.filter((quest: QuestmasterTask) => quest.status === "idea").length,
      refined: withoutStatus.filter((quest: QuestmasterTask) => quest.status === "refined").length,
      in_progress: withoutStatus.filter((quest: QuestmasterTask) => quest.status === "in_progress").length,
      done: withoutStatus.filter((quest: QuestmasterTask) => quest.status === "done").length,
    },
    allTags: Array.from(new Set(mockState.quests.flatMap((quest: QuestmasterTask) => quest.tags ?? []))).sort(),
  };
}

function sortMockQuests(quests: QuestmasterTask[], options: MockQuestPageOptions) {
  if (options.sortColumn === "quest") {
    return [...quests].sort((left, right) =>
      left.questId.localeCompare(right.questId, undefined, { numeric: true, sensitivity: "base" }),
    );
  }
  return [...quests].sort((left, right) => mockQuestRecencyTs(right) - mockQuestRecencyTs(left));
}

function mockQuestRecencyTs(quest: QuestmasterTask) {
  return Math.max(quest.createdAt, quest.updatedAt ?? 0, quest.statusChangedAt ?? 0);
}

vi.mock("../store.js", () => {
  const useStoreFn = (selector: (state: any) => unknown) => selector(mockState);
  useStoreFn.getState = () => mockState;
  return {
    useStore: useStoreFn,
    countUserPermissions: () => 0,
  };
});

import { QuestmasterPage } from "./QuestmasterPage.js";

function renderQuestmaster() {
  return render(<QuestmasterPage isActive={true} />);
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
  resetState({
    quests: [makeQuest({ questId: "q-1", title: "Needle quest", description: "needle match" })],
  });
  mockListQuestPage.mockImplementation(async (options?: MockQuestPageOptions) => makeMockQuestPage(options));
  mockCreateQuest.mockImplementation(async (input: { title: string; description?: string; tags?: string[] }) =>
    makeQuest({ questId: "q-created", title: input.title, description: input.description, tags: input.tags }),
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

describe("QuestmasterPage paged browsing rework", () => {
  it("refreshes the current loaded window instead of replacing it with page one", async () => {
    mockState.questmasterViewMode = "compact";
    mockState.questmasterCompactSort = { column: "quest", direction: "asc" };
    mockGetSettings.mockResolvedValue({
      questmasterViewMode: "compact",
      questmasterCompactSort: { column: "quest", direction: "asc" },
    });
    mockState.quests = Array.from({ length: 200 }, (_, index) => {
      const questNumber = index + 1;
      return makeQuest({
        questId: `q-${questNumber}`,
        title: `Generated quest ${String(questNumber).padStart(3, "0")}`,
        status: "done",
        createdAt: questNumber,
        updatedAt: questNumber,
      });
    });

    renderQuestmaster();

    await waitFor(() => expect(renderedQuestIds()[0]).toBe("q-1"));
    clickLoadMore();
    await waitFor(() =>
      expect(mockListQuestPage).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 50, limit: 50 })),
    );
    clickLoadMore();
    await waitFor(() =>
      expect(mockListQuestPage).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 100, limit: 50 })),
    );
    clickLoadMore();
    await waitFor(() => {
      expect(mockListQuestPage).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 150, limit: 50 }));
      expect(renderedQuestIds()[0]).toBe("q-51");
      expect(screen.getByText("Showing 51-200 of 200")).toBeInTheDocument();
    });

    mockListQuestPage.mockClear();
    window.dispatchEvent(new Event("focus"));

    await waitFor(() => {
      expect(mockListQuestPage).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 50, limit: 150 }));
      expect(renderedQuestIds()[0]).toBe("q-51");
      expect(screen.getByText("Showing 51-200 of 200")).toBeInTheDocument();
    });
  });

  it("does not insert a newly created quest into a page filtered by nonmatching search text", async () => {
    mockState.questmasterSearchQuery = "needle";

    renderQuestmaster();

    await waitFor(() => {
      expect(renderedQuestIds()).toContain("q-1");
    });

    fireEvent.click(screen.getByRole("button", { name: /New Quest/i }));
    fireEvent.change(screen.getByPlaceholderText("Quest title"), { target: { value: "Unrelated draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(mockState.openQuestOverlay).toHaveBeenCalledWith("q-created"));
    expect(screen.queryByText("Unrelated draft")).not.toBeInTheDocument();
    expect(renderedQuestIds()).toEqual(["q-1"]);
  });
});
