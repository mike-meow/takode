// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { QuestmasterTask } from "../types.js";

const mockCreateQuest = vi.fn();
const mockGetSettings = vi.fn();
const mockUpdateSettings = vi.fn();
let promptSpy: ReturnType<typeof vi.spyOn>;

vi.mock("../api.js", () => ({
  api: {
    createQuest: (...args: unknown[]) => mockCreateQuest(...args),
    getSettings: (...args: unknown[]) => mockGetSettings(...args),
    updateSettings: (...args: unknown[]) => mockUpdateSettings(...args),
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
    status: "needs_verification",
    description: "Needs review",
    sessionId: "session-1",
    claimedAt: Date.now(),
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

beforeEach(() => {
  vi.clearAllMocks();
  promptSpy = vi.spyOn(window, "prompt").mockReturnValue("");
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
  mockGetSettings.mockResolvedValue({ questmasterViewMode: "cards" });
  mockUpdateSettings.mockImplementation(async (input: { questmasterViewMode?: "cards" | "compact" }) => ({
    questmasterViewMode: input.questmasterViewMode ?? "cards",
  }));
  window.location.hash = "#/questmaster";
});

afterEach(() => {
  promptSpy.mockRestore();
});

describe("QuestmasterPage verification inbox", () => {
  it("renders inbox quests separately from regular verification quests", () => {
    // Inbox should be a distinct section so reviewers can triage fresh updates first.
    renderQuestmaster();

    expect(screen.getByText("Verification Inbox")).toBeInTheDocument();
    expect(screen.getByText(/^Verification$/)).toBeInTheDocument();
    expect(screen.getByText("Inbox quest")).toBeInTheDocument();
    expect(screen.getByText("Regular verification quest")).toBeInTheDocument();
  });

  it("collapses and expands the verification inbox section", () => {
    // Inbox should behave like other grouped sections and support collapse toggling.
    renderQuestmaster();

    const inboxHeader = screen.getByText("Verification Inbox");
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
    expect(screen.queryByText("Verification Inbox")).not.toBeVisible();
    expect(screen.getByRole("button", { name: /q-1 Inbox quest/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /q-2 Regular verification quest/ })).toBeInTheDocument();
  });

  it("orders compact rows by newest update without grouping by status", async () => {
    // Compact mode is one updated-time-sorted work-board-style table, independent of quest status buckets.
    mockGetSettings.mockResolvedValueOnce({ questmasterViewMode: "compact" });
    mockState.quests = [
      {
        ...buildVerificationQuest({ id: "q-20-v1", questId: "q-20", title: "Old verification" }),
        updatedAt: 1_000,
      } as QuestmasterTask,
      {
        ...buildVerificationQuest({ id: "q-21-v1", questId: "q-21", title: "Newest refined" }),
        status: "refined",
        updatedAt: 9_000,
      } as QuestmasterTask,
      {
        ...buildVerificationQuest({ id: "q-22-v1", questId: "q-22", title: "Middle progress" }),
        status: "in_progress",
        updatedAt: 5_000,
      } as QuestmasterTask,
    ];

    renderQuestmaster({ isActive: true });

    await screen.findByRole("button", { name: /q-21 Newest refined/ });
    const rows = screen
      .getAllByRole("button")
      .map((el) => el.getAttribute("data-quest-id"))
      .filter(Boolean);
    expect(rows).toEqual(["q-21", "q-22", "q-20"]);
    expect(screen.getAllByRole("table")).toHaveLength(1);
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

  it("opens compact rows even when their Cards-mode section is collapsed", async () => {
    // Compact view is flat: a previously-collapsed Cards group must not prevent overlay.
    renderQuestmaster();

    fireEvent.click(screen.getByText("Verification Inbox"));
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
    expect(screen.queryByPlaceholderText("Quest title")).toBeNull();
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
