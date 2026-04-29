// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { QuestmasterTask } from "../types.js";

const mockCreateQuest = vi.fn();
const mockGetSettings = vi.fn();
const mockUpdateSettings = vi.fn();
const mockUploadStandaloneQuestImage = vi.fn();
const mockClipboardWriteText = vi.fn();
let promptSpy: ReturnType<typeof vi.spyOn>;

vi.mock("../api.js", () => ({
  api: {
    createQuest: (...args: unknown[]) => mockCreateQuest(...args),
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
};

let mockState: MockStoreState;

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
    sdkSessions: [],
    sessionNames: new Map(),
    ...overrides,
  };
}

vi.mock("../store.js", () => {
  const useStoreFn = (selector: (s: MockStoreState) => unknown) => selector(mockState);
  useStoreFn.getState = () => mockState;
  return {
    useStore: useStoreFn,
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

beforeEach(() => {
  vi.clearAllMocks();
  promptSpy = vi.spyOn(window, "prompt").mockReturnValue("");
  mockClipboardWriteText.mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText: mockClipboardWriteText } });
  const inboxQuest = buildVerificationQuest({
    id: "q-1-v3",
    questId: "q-1",
    title: "Inbox quest",
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

describe("QuestmasterPage review inbox", () => {
  it("renders inbox quests separately from regular review quests", () => {
    // Inbox should be a distinct section so reviewers can triage fresh updates first.
    renderQuestmaster();

    expect(screen.getByText("Review Inbox")).toBeInTheDocument();
    expect(screen.getByText("Under Review")).toBeInTheDocument();
    expect(screen.getByText("Inbox quest")).toBeInTheDocument();
    expect(screen.getByText("Regular verification quest")).toBeInTheDocument();
  });

  it("collapses and expands the review inbox section", () => {
    // Inbox should behave like other grouped sections and support collapse toggling.
    renderQuestmaster();

    const inboxHeader = screen.getByText("Review Inbox");
    expect(screen.getByText("Inbox quest")).toBeInTheDocument();

    fireEvent.click(inboxHeader);
    expect(screen.queryByText("Inbox quest")).toBeNull();
    expect(screen.getByText("Regular verification quest")).toBeInTheDocument();

    fireEvent.click(inboxHeader);
    expect(screen.getByText("Inbox quest")).toBeInTheDocument();
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
    renderQuestmaster();

    const order = Array.from(document.querySelectorAll<HTMLElement>("[data-quest-id]")).map((el) => el.dataset.questId);
    expect(order).toEqual(["q-10", "q-11"]);
  });

  it("loads the server-persisted compact view and renders quests as dense rows", async () => {
    // View mode is a server setting: activating Questmaster should hydrate the compact table without localStorage.
    mockGetSettings.mockResolvedValueOnce({ questmasterViewMode: "compact" });

    renderQuestmaster({ isActive: true });

    expect(await screen.findAllByRole("columnheader", { name: "Quest" })).toHaveLength(1);
    expect(screen.getAllByRole("columnheader", { name: "Owner" })).toHaveLength(1);
    expect(screen.getAllByRole("columnheader", { name: "Verify" })).toHaveLength(1);
    expect(screen.getAllByRole("table")).toHaveLength(1);
    expect(screen.queryByText("Review Inbox")).not.toBeVisible();
    expect(screen.getByRole("button", { name: /q-1 Inbox quest/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /q-2 Regular verification quest/ })).toBeInTheDocument();
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
      expect(mockState.refreshQuests).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(15_000);
      });
      expect(mockState.refreshQuests).toHaveBeenCalledTimes(1);

      visibilityState = "visible";
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(mockState.refreshQuests).toHaveBeenCalledTimes(2);

      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });
      expect(mockState.refreshQuests).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
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
    expect(compactRowQuestIds()).toEqual(["q-21", "q-22", "q-20"]);
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
    expect(compactRowQuestIds()).toEqual(["q-41", "q-40"]);
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

    fireEvent.change(screen.getByPlaceholderText("Search or #tag..."), { target: { value: "Keep" } });

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
    fireEvent.click(screen.getByRole("button", { name: /^Refined1$/ }));

    expect(screen.queryByRole("button", { name: /q-30 Verification row/ })).toBeNull();
    expect(screen.getByRole("button", { name: /q-31 Refined row/ })).toBeInTheDocument();
    expect(screen.getAllByRole("table")).toHaveLength(1);
  });

  it("saves the compact/cards toggle to server settings", async () => {
    // Toggling should PUT the preference to the server and immediately swap card list for table view.
    renderQuestmaster();

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
    renderQuestmaster();

    fireEvent.click(screen.getByRole("button", { name: "Compact" }));
    await screen.findAllByRole("columnheader", { name: "Quest" });

    fireEvent.click(screen.getByRole("button", { name: /q-1 Inbox quest/ }));

    expect(mockState.openQuestOverlay).toHaveBeenCalledWith("q-1", undefined);
    expect(mockState.questOverlayId).toBe("q-1");
  });

  it("copies the quest id from a card without opening the overlay", async () => {
    renderQuestmaster();

    fireEvent.click(screen.getByRole("button", { name: "q-1" }));

    await waitFor(() => {
      expect(mockClipboardWriteText).toHaveBeenCalledWith("q-1");
    });
    expect(mockState.openQuestOverlay).not.toHaveBeenCalled();
    expect(mockState.questOverlayId).toBeNull();
    expect(screen.getByRole("button", { name: "Copied!" })).toBeInTheDocument();
  });

  it("copies the quest id from a compact row without opening the overlay", async () => {
    mockGetSettings.mockResolvedValueOnce({ questmasterViewMode: "compact" });

    renderQuestmaster({ isActive: true });
    await screen.findByRole("button", { name: /q-1 Inbox quest/ });

    fireEvent.click(screen.getAllByRole("button", { name: "q-1" })[0]);

    await waitFor(() => {
      expect(mockClipboardWriteText).toHaveBeenCalledWith("q-1");
    });
    expect(mockState.openQuestOverlay).not.toHaveBeenCalled();
    expect(mockState.questOverlayId).toBeNull();
  });

  it("blocks compact row keyboard open when the quest id button is activated", async () => {
    mockGetSettings.mockResolvedValueOnce({ questmasterViewMode: "compact" });

    renderQuestmaster({ isActive: true });
    await screen.findByRole("button", { name: /q-1 Inbox quest/ });

    const copyButton = screen.getAllByRole("button", { name: "q-1" })[0];

    // JSDOM does not synthesize the native click from Enter, so assert the
    // keydown does not bubble to the row, then emulate the activation click.
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
    renderQuestmaster();

    fireEvent.click(screen.getByText("Review Inbox"));
    expect(screen.queryByText("Inbox quest")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Compact" }));
    await screen.findByRole("button", { name: /q-1 Inbox quest/ });

    fireEvent.click(screen.getByRole("button", { name: /q-1 Inbox quest/ }));

    expect(mockState.questOverlayId).toBe("q-1");
  });

  it("opens quest overlay via deep-link", () => {
    // Deep-linking should open the targeted quest via the store overlay.
    window.location.hash = "#/questmaster?quest=q-2";
    renderQuestmaster();

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
    renderQuestmaster();

    const card = document.querySelector('[data-quest-id="q-1"]');
    expect(card).toBeTruthy();
    expect(card!.className).toContain("border-cc-primary");
  });

  it("filters quests by quest id from the search box", () => {
    // Questmaster search should support direct quest-id lookup so users can
    // jump to a known quest like q-2 without remembering the title text.
    renderQuestmaster();

    const searchInput = screen.getByPlaceholderText("Search or #tag...");

    fireEvent.change(searchInput, { target: { value: "q-2" } });
    expect(screen.getByText("Regular verification quest")).toBeInTheDocument();
    expect(screen.queryByText("Inbox quest")).toBeNull();

    fireEvent.change(searchInput, { target: { value: "Q-1" } });
    expect(screen.getByText("Inbox quest")).toBeInTheDocument();
    expect(screen.queryByText("Regular verification quest")).toBeNull();
  });

  it("filters by TLDR and full feedback text when feedback has TLDR metadata", () => {
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

    renderQuestmaster();

    const searchInput = screen.getByPlaceholderText("Search or #tag...");
    fireEvent.change(searchInput, { target: { value: "scanline" } });
    expect(document.querySelector('[data-quest-id="q-30"]')).toBeTruthy();
    expect(document.querySelector('[data-quest-id="q-31"]')).toBeNull();

    fireEvent.change(searchInput, { target: { value: "implementation" } });
    expect(document.querySelector('[data-quest-id="q-30"]')).toBeTruthy();
    expect(document.querySelector('[data-quest-id="q-31"]')).toBeNull();
  });

  it("preserves plain-text title search while ignoring negated-tag syntax", () => {
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

    renderQuestmaster();

    const searchInput = screen.getByPlaceholderText("Search or #tag...");
    fireEvent.change(searchInput, { target: { value: "backend" } });

    expect(document.querySelector('[data-quest-id="q-41"]')).toBeTruthy();
    expect(document.querySelector('[data-quest-id="q-40"]')).toBeNull();
  });

  it("preserves positive #tag search through the existing autocomplete tag-pill flow", () => {
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

    renderQuestmaster();

    const searchInput = screen.getByPlaceholderText("Search or #tag...");
    fireEvent.change(searchInput, { target: { value: "#mob" } });
    fireEvent.keyDown(searchInput, { key: "Enter" });

    expect(screen.getByText("#mobile")).toBeInTheDocument();
    expect(screen.getByText("Auth mobile quest")).toBeInTheDocument();
    expect(screen.getByText("Infra mobile quest")).toBeInTheDocument();
    expect(screen.queryByText("Auth backend quest")).toBeNull();
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

    renderQuestmaster();

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

    renderQuestmaster();

    const searchInput = screen.getByPlaceholderText("Search or #tag...") as HTMLInputElement;
    fireEvent.focus(searchInput);
    fireEvent.change(searchInput, { target: { value: "!#" } });

    expect(screen.getByText("excluding:")).toBeInTheDocument();
    fireEvent.keyDown(searchInput, { key: "Enter" });

    expect(searchInput.value).toBe("!#alpha");
    expect(screen.queryByText("#alpha")).toBeNull();
  });

  it("supports -#tag to exclude quests with matching tags", () => {
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

    renderQuestmaster();

    const searchInput = screen.getByPlaceholderText("Search or #tag...");
    fireEvent.change(searchInput, { target: { value: "!#mobile" } });

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

  it("treats numeric-leading hashtag tokens as plain text search", () => {
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

    renderQuestmaster();

    const searchInput = screen.getByPlaceholderText("Search or #tag...");
    fireEvent.change(searchInput, { target: { value: "#123" } });

    expect(document.querySelector('[data-quest-id="q-67"]')).toBeTruthy();
    expect(document.querySelector('[data-quest-id="q-68"]')).toBeNull();
    expect(screen.queryByText("excluding:")).toBeNull();
  });

  it("supports mixed free-text plus negated-tag queries and only highlights the positive text", () => {
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

    const { container } = renderQuestmaster();

    const searchInput = screen.getByPlaceholderText("Search or #tag...");
    fireEvent.change(searchInput, { target: { value: "auth !#mobile" } });

    expect(document.querySelector('[data-quest-id="q-71"]')).toBeTruthy();
    expect(document.querySelector('[data-quest-id="q-70"]')).toBeNull();
    expect(document.querySelector('[data-quest-id="q-72"]')).toBeNull();

    const marks = Array.from(container.querySelectorAll("mark")).map((el) => el.textContent?.toLowerCase());
    expect(marks).toContain("auth");
    expect(marks).not.toContain("mobile");
  });

  it("supports mixed positive #tag pills plus negated-tag queries", () => {
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

    renderQuestmaster();

    const searchInput = screen.getByPlaceholderText("Search or #tag...");
    fireEvent.change(searchInput, { target: { value: "#auth" } });
    fireEvent.keyDown(searchInput, { key: "Enter" });
    expect(screen.getByText("#auth")).toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: "!#backend" } });

    expect(document.querySelector('[data-quest-id="q-80"]')).toBeTruthy();
    expect(document.querySelector('[data-quest-id="q-81"]')).toBeNull();
    expect(document.querySelector('[data-quest-id="q-82"]')).toBeNull();
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

    fireEvent.click(screen.getByText("Inbox quest"));

    expect(mockState.closeQuestOverlay).toHaveBeenCalled();
    expect(mockState.questOverlayId).toBeNull();
  });
});
