// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { QuestmasterTask } from "../types.js";
import { buildQuestReworkDraft } from "./quest-rework.js";

const mockMarkQuestVerificationRead = vi.fn();
const mockMarkQuestVerificationInbox = vi.fn();
const mockTransitionQuest = vi.fn();
const mockCreateQuest = vi.fn();
const mockMarkQuestDone = vi.fn();
const mockNavigateToSession = vi.fn();
let promptSpy: ReturnType<typeof vi.spyOn>;

vi.mock("../api.js", () => ({
  api: {
    markQuestVerificationRead: (...args: unknown[]) => mockMarkQuestVerificationRead(...args),
    markQuestVerificationInbox: (...args: unknown[]) => mockMarkQuestVerificationInbox(...args),
    transitionQuest: (...args: unknown[]) => mockTransitionQuest(...args),
    createQuest: (...args: unknown[]) => mockCreateQuest(...args),
    markQuestDone: (...args: unknown[]) => mockMarkQuestDone(...args),
    questImageUrl: (id: string) => `/api/quests/_images/${id}`,
  },
}));

vi.mock("../utils/routing.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/routing.js")>();
  return {
    ...actual,
    navigateToSession: (...args: unknown[]) => mockNavigateToSession(...args),
  };
});

vi.mock("../utils/questmaster-view-state.js", () => ({
  VERIFICATION_INBOX_COLLAPSE_KEY: "verification_inbox",
  loadQuestmasterViewState: () => null,
  saveQuestmasterViewState: vi.fn(),
}));

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
  sdkSessions: Array<{
    sessionId: string;
    state: "connected";
    cwd: string;
    createdAt: number;
    archived: boolean;
    sessionNum?: number;
    backendType?: string;
  }>;
  sessionNames: Map<string, string>;
  sessions: Map<string, Record<string, unknown>>;
  cliConnected: Map<string, boolean>;
  sessionStatus: Map<string, "idle" | "running" | "compacting" | null>;
  cliDisconnectReason: Map<string, "idle_limit" | null>;
  pendingPermissions: Map<string, Map<string, unknown>>;
  sessionPreviews: Map<string, string>;
  askPermission: Map<string, boolean>;
  sessionTaskPreview: Map<string, { text: string; updatedAt: number }>;
  sessionPreviewUpdatedAt: Map<string, number>;
  setComposerDraft: ReturnType<typeof vi.fn>;
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
    sdkSessions: [],
    sessionNames: new Map(),
    sessions: new Map(),
    cliConnected: new Map(),
    sessionStatus: new Map(),
    cliDisconnectReason: new Map(),
    pendingPermissions: new Map(),
    sessionPreviews: new Map(),
    askPermission: new Map(),
    sessionTaskPreview: new Map(),
    sessionPreviewUpdatedAt: new Map(),
    setComposerDraft: vi.fn(),
    ...overrides,
  };
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
    sdkSessions: [
      {
        sessionId: "session-1",
        state: "connected",
        cwd: "/tmp/project",
        createdAt: Date.now(),
        archived: false,
        sessionNum: 5,
      },
    ],
    sessionNames: new Map([["session-1", "Session One"]]),
  });
  mockMarkQuestVerificationRead.mockImplementation(async (questId: string) => {
    const quest = mockState.quests.find((q) => q.questId === questId);
    if (!quest || quest.status !== "needs_verification") throw new Error("quest not found");
    return { ...quest, verificationInboxUnread: false } as QuestmasterTask;
  });
  mockMarkQuestVerificationInbox.mockImplementation(async (questId: string) => {
    const quest = mockState.quests.find((q) => q.questId === questId);
    if (!quest || quest.status !== "needs_verification") throw new Error("quest not found");
    return { ...quest, verificationInboxUnread: true } as QuestmasterTask;
  });
  mockTransitionQuest.mockImplementation(
    async (
      questId: string,
      input: {
        status: "done" | "idea" | "refined" | "in_progress" | "needs_verification";
        sessionId?: string;
      },
    ) => {
      const quest = mockState.quests.find((q) => q.questId === questId);
      if (!quest) throw new Error("quest not found");
      return { ...quest, status: input.status } as QuestmasterTask;
    },
  );
  mockMarkQuestDone.mockImplementation(
    async (questId: string, input?: { verificationItems?: Array<{ text: string; checked: boolean }> }) => {
      const quest = mockState.quests.find((q) => q.questId === questId);
      if (!quest) throw new Error("quest not found");
      const currentSessionId =
        "sessionId" in quest && typeof quest.sessionId === "string" ? quest.sessionId : undefined;
      const previousOwners = Array.isArray((quest as { previousOwnerSessionIds?: string[] }).previousOwnerSessionIds)
        ? [...((quest as { previousOwnerSessionIds?: string[] }).previousOwnerSessionIds ?? [])]
        : [];
      if (currentSessionId && !previousOwners.includes(currentSessionId)) previousOwners.push(currentSessionId);
      return {
        ...quest,
        id: `${quest.questId}-v${quest.version + 1}`,
        version: quest.version + 1,
        status: "done",
        verificationItems: input?.verificationItems ?? ("verificationItems" in quest ? quest.verificationItems : []),
        completedAt: Date.now(),
        previousOwnerSessionIds: previousOwners,
        sessionId: undefined,
      } as QuestmasterTask;
    },
  );
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

  it("marks an inbox quest as read", async () => {
    // Clicking Later should remove an inbox item from the inbox split and close the modal.
    renderQuestmaster();

    fireEvent.click(screen.getByText("Inbox quest"));
    fireEvent.click(screen.getByText(/^Later$/));

    await waitFor(() => {
      expect(mockMarkQuestVerificationRead).toHaveBeenCalledWith("q-1");
      const quest = mockState.quests.find((q) => q.questId === "q-1");
      expect(quest).toBeTruthy();
      expect((quest as { verificationInboxUnread?: boolean }).verificationInboxUnread).toBe(false);
      expect(screen.queryByLabelText("Close quest details")).toBeNull();
    });
  });

  it("moves a regular verification quest into inbox", async () => {
    // Clicking Inbox should move a regular verification quest back to inbox.
    renderQuestmaster();

    fireEvent.click(screen.getByText("Regular verification quest"));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByText(/^Inbox$/));

    await waitFor(() => {
      expect(mockMarkQuestVerificationInbox).toHaveBeenCalledWith("q-2");
      const quest = mockState.quests.find((q) => q.questId === "q-2");
      expect(quest).toBeTruthy();
      expect((quest as { verificationInboxUnread?: boolean }).verificationInboxUnread).toBe(true);
    });
  });

  it("opens deep-linked quest in modal and closes it", () => {
    // Deep-linking should open the targeted quest in modal detail view.
    window.location.hash = "#/questmaster?quest=q-2";
    renderQuestmaster();

    const dialog = screen.getByRole("dialog");
    expect(screen.getByLabelText("Close quest details")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Inbox" })).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Close quest details"));

    expect(screen.queryByLabelText("Close quest details")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(window.location.hash).toBe("#/questmaster");
  });

  it("opens from a session quest query and closes back to that session route", () => {
    window.location.hash = "#/session/session-1?quest=q-2";
    renderQuestmaster();

    expect(screen.getByRole("button", { name: "Close quest details" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close quest details" }));

    expect(window.location.hash).toBe("#/session/session-1");
  });

  it("shows collapsed-card metadata in the quest modal header", () => {
    // Modal should be a superset of card info: inbox/session/progress/feedback/time/tags.
    window.location.hash = "#/questmaster?quest=q-1";
    renderQuestmaster();

    const dialog = screen.getByRole("dialog", { name: /Quest details: Inbox quest/ });
    expect(within(dialog).getByText("Inbox")).toBeInTheDocument();
    expect(within(dialog).getByText("#5")).toBeInTheDocument();
    expect(within(dialog).getByText("0/1")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("1 pending feedback")).toBeInTheDocument();
    expect(within(dialog).getByText("ui")).toBeInTheDocument();
  });

  it("shows full session tooltip when hovering a compact session number chip", async () => {
    window.location.hash = "#/questmaster?quest=q-1";
    renderQuestmaster();

    const dialog = screen.getByRole("dialog", { name: /Quest details: Inbox quest/ });
    const sessionChip = within(dialog).getByRole("button", { name: "#5" });

    vi.useFakeTimers();
    try {
      fireEvent.mouseEnter(sessionChip);
      act(() => {
        vi.advanceTimersByTime(350);
      });
      expect(screen.getByText("Session One")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses harmonious action hierarchy colors for verification inbox UI", () => {
    // Keep status identity subtle on chips, and keep action buttons aligned
    // with a consistent hierarchy (primary orange, secondary neutral).
    window.location.hash = "#/questmaster?quest=q-1";
    renderQuestmaster();

    const dialog = screen.getByRole("dialog", { name: /Quest details: Inbox quest/ });
    expect(within(dialog).getByText("Inbox")).toHaveClass("text-cc-muted");
    expect(within(dialog).getByRole("button", { name: "Later" })).toHaveClass("text-cc-muted");
    expect(within(dialog).getByRole("button", { name: "Finish Quest" })).toHaveClass("bg-cc-primary");
    expect(within(dialog).getByRole("button", { name: "Rework" })).toHaveClass("bg-cc-hover");
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

  it("renders agent feedback with compact session number and opens that session on click", () => {
    mockState.quests = [
      {
        id: "q-8-v4",
        questId: "q-8",
        version: 4,
        title: "Quest with agent feedback",
        createdAt: Date.now(),
        status: "done",
        description: "Done",
        verificationItems: [{ text: "checked", checked: true }],
        completedAt: Date.now(),
        feedback: [
          {
            author: "agent",
            authorSessionId: "session-1",
            text: "Implemented and verified.",
            ts: Date.now(),
          },
        ],
      } as QuestmasterTask,
    ];
    window.location.hash = "#/questmaster?quest=q-8";
    renderQuestmaster();

    const dialog = screen.getByRole("dialog", { name: /Quest details: Quest with agent feedback/ });
    fireEvent.click(within(dialog).getByRole("button", { name: "#5" }));

    expect(mockNavigateToSession).toHaveBeenCalledWith("session-1");
  });

  it("keeps feedback session chips compact even with long session titles", () => {
    mockState.sessionNames = new Map([["session-1", "Codex web search tool call is not rendered correctly"]]);
    mockState.quests = [
      {
        id: "q-9-v2",
        questId: "q-9",
        version: 2,
        title: "Quest with long session title",
        createdAt: Date.now(),
        status: "done",
        description: "Done",
        verificationItems: [{ text: "checked", checked: true }],
        completedAt: Date.now(),
        feedback: [
          {
            author: "agent",
            authorSessionId: "session-1",
            text: "Done.",
            ts: Date.now(),
          },
        ],
      } as QuestmasterTask,
    ];

    window.location.hash = "#/questmaster?quest=q-9";
    renderQuestmaster();

    const dialog = screen.getByRole("dialog", { name: /Quest details: Quest with long session title/ });
    const labelButton = within(dialog).getByRole("button", { name: "#5" });
    expect(labelButton).toHaveTextContent("#5");
    expect(within(dialog).queryByText(/Codex web search tool call is not rendered correctly/)).toBeNull();
  });

  it("prefills and navigates when clicking Rework with unaddressed feedback", () => {
    window.location.hash = "#/questmaster?quest=q-1";
    renderQuestmaster();

    const dialog = screen.getByRole("dialog", { name: /Quest details: Inbox quest/ });
    const reworkButton = within(dialog).getByRole("button", { name: "Rework" });
    expect(reworkButton).toBeEnabled();

    fireEvent.click(reworkButton);

    expect(mockState.setComposerDraft).toHaveBeenCalledWith("session-1", {
      text: buildQuestReworkDraft("q-1"),
      images: [],
    });
    expect(mockNavigateToSession).toHaveBeenCalledWith("session-1");
  });

  it("shows Rework in the bottom action row next to Finish Quest", () => {
    window.location.hash = "#/questmaster?quest=q-1";
    renderQuestmaster();

    const dialog = screen.getByRole("dialog", { name: /Quest details: Inbox quest/ });
    const reworkButtons = within(dialog).getAllByRole("button", { name: "Rework" });
    const finishButton = within(dialog).getByRole("button", { name: "Finish Quest" });

    expect(reworkButtons).toHaveLength(1);
    expect(reworkButtons[0].parentElement).toBe(finishButton.parentElement);
  });

  it("clicking Finish Quest closes the quest details modal", async () => {
    window.location.hash = "#/questmaster?quest=q-1";
    renderQuestmaster();

    const dialog = screen.getByRole("dialog", { name: /Quest details: Inbox quest/ });
    fireEvent.click(within(dialog).getByRole("button", { name: "Finish Quest" }));

    await waitFor(() => {
      expect(mockMarkQuestDone).toHaveBeenCalledWith("q-1");
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: /Quest details: Inbox quest/ })).toBeNull();
    });
  });

  it("Finish Quest calls markQuestDone with just the quest ID", async () => {
    window.location.hash = "#/questmaster?quest=q-1";
    renderQuestmaster();

    const dialog = screen.getByRole("dialog", { name: /Quest details: Inbox quest/ });
    fireEvent.click(within(dialog).getByRole("button", { name: "Finish Quest" }));

    await waitFor(() => {
      expect(mockMarkQuestDone).toHaveBeenCalledTimes(1);
      expect(mockMarkQuestDone).toHaveBeenCalledWith("q-1");
    });
  });

  it("includes fallback verification items when marking an in-progress quest done", async () => {
    // Regression: done transitions from in_progress have no verification checklist,
    // so the UI must provide a fallback item to satisfy server validation.
    mockState.quests = [
      {
        id: "q-12-v2",
        questId: "q-12",
        version: 2,
        title: "In-progress quest",
        createdAt: Date.now(),
        status: "in_progress",
        description: "Implement the feature",
        sessionId: "session-1",
        claimedAt: Date.now(),
      } as QuestmasterTask,
    ];
    window.location.hash = "#/questmaster?quest=q-12";
    renderQuestmaster();

    const dialog = screen.getByRole("dialog", { name: /Quest details: In-progress quest/ });
    fireEvent.change(within(dialog).getByDisplayValue("In Progress"), {
      target: { value: "done" },
    });

    await waitFor(() => {
      expect(mockMarkQuestDone).toHaveBeenCalledWith("q-12", {
        verificationItems: [
          {
            text: "User marked this quest as done in Questmaster.",
            checked: true,
          },
        ],
      });
    });
  });

  it("shows previous owner session info for done quests", () => {
    mockState.quests = [
      {
        id: "q-9-v5",
        questId: "q-9",
        version: 5,
        title: "Completed quest",
        createdAt: Date.now(),
        status: "done",
        description: "Done",
        verificationItems: [{ text: "checked", checked: true }],
        completedAt: Date.now(),
        previousOwnerSessionIds: ["session-1"],
      } as QuestmasterTask,
    ];
    window.location.hash = "#/questmaster?quest=q-9";
    renderQuestmaster();

    expect(screen.getAllByText("#5").length).toBeGreaterThan(0);
  });

  it("includes owner session id when transitioning done quest back to verification", async () => {
    // Done quests can lose active sessionId, so transition payload must reuse the
    // most recent owner to satisfy server validation for needs_verification.
    mockState.quests = [
      {
        id: "q-11-v5",
        questId: "q-11",
        version: 5,
        title: "Done quest for rework",
        createdAt: Date.now(),
        status: "done",
        description: "Needs follow-up",
        verificationItems: [{ text: "checked", checked: true }],
        completedAt: Date.now(),
        previousOwnerSessionIds: ["session-1"],
      } as QuestmasterTask,
    ];
    window.location.hash = "#/questmaster?quest=q-11";
    renderQuestmaster();

    const dialog = screen.getByRole("dialog", { name: /Quest details: Done quest for rework/ });
    fireEvent.change(within(dialog).getByDisplayValue("Done"), {
      target: { value: "needs_verification" },
    });

    await waitFor(() => {
      expect(mockTransitionQuest).toHaveBeenCalledWith("q-11", {
        status: "needs_verification",
        sessionId: "session-1",
      });
    });
  });

  it("navigates when clicking compact codex owner session chip in quest modal", () => {
    mockState.quests = [
      {
        id: "q-10-v3",
        questId: "q-10",
        version: 3,
        title: "Codex linked quest",
        createdAt: Date.now(),
        status: "needs_verification",
        description: "Verify codex navigation",
        sessionId: "codex-session-1",
        claimedAt: Date.now(),
        verificationItems: [{ text: "Verify", checked: false }],
      } as QuestmasterTask,
    ];
    mockState.sdkSessions = [
      {
        sessionId: "codex-session-1",
        state: "connected",
        cwd: "/tmp/codex-project",
        createdAt: Date.now(),
        archived: false,
        sessionNum: 6,
      },
    ];
    mockState.sessionNames = new Map([["codex-session-1", "Codex Session One"]]);

    window.location.hash = "#/questmaster?quest=q-10";
    renderQuestmaster();

    const dialog = screen.getByRole("dialog", { name: /Quest details: Codex linked quest/ });
    fireEvent.click(within(dialog).getByRole("button", { name: "#6" }));

    expect(mockNavigateToSession).toHaveBeenCalledWith("codex-session-1");
  });

  it("disables Rework when all human feedback is addressed", () => {
    mockState.quests = mockState.quests.map((q) =>
      q.questId === "q-1"
        ? ({
            ...q,
            feedback: [{ author: "human", text: "done", ts: Date.now(), addressed: true }],
          } as QuestmasterTask)
        : q,
    );
    window.location.hash = "#/questmaster?quest=q-1";
    renderQuestmaster();

    const dialog = screen.getByRole("dialog", { name: /Quest details: Inbox quest/ });
    expect(within(dialog).getByRole("button", { name: "Rework" })).toBeDisabled();
  });

  it("renders feedback image thumbnails and opens a lightbox from quest feedback entries", () => {
    mockState.quests = mockState.quests.map((q) =>
      q.questId === "q-1"
        ? ({
            ...q,
            feedback: [
              {
                author: "agent",
                text: "Screenshot attached for validation.",
                ts: Date.now(),
                images: [
                  {
                    id: "feedback-img-1",
                    filename: "server-proof.png",
                    mimeType: "image/png",
                    path: "/home/jiayiwei/.companion/questmaster/images/feedback-img-1.png",
                  },
                ],
              },
            ],
          } as QuestmasterTask)
        : q,
    );
    window.location.hash = "#/questmaster?quest=q-1";
    renderQuestmaster();

    const dialog = screen.getByRole("dialog", { name: /Quest details: Inbox quest/ });
    const thumb = within(dialog).getByTitle("server-proof.png");
    expect(thumb).toHaveAttribute("src", "/api/quests/_images/feedback-img-1");

    fireEvent.click(thumb);
    expect(screen.getByTestId("lightbox-backdrop")).toBeInTheDocument();
  });

  it("closes lightbox first on Escape and keeps quest modal open", async () => {
    mockState.quests = mockState.quests.map((q) =>
      q.questId === "q-1"
        ? ({
            ...q,
            images: [
              {
                id: "img-1",
                filename: "proof.png",
                mimeType: "image/png",
                path: "/tmp/proof.png",
              },
            ],
          } as QuestmasterTask)
        : q,
    );
    window.location.hash = "#/questmaster?quest=q-1";
    renderQuestmaster();

    const dialog = screen.getByRole("dialog", { name: /Quest details: Inbox quest/ });
    fireEvent.click(within(dialog).getByAltText("proof.png"));
    expect(screen.getByTestId("lightbox-backdrop")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByTestId("lightbox-backdrop")).toBeNull();
    });
    expect(screen.getByRole("dialog", { name: /Quest details: Inbox quest/ })).toBeInTheDocument();
  });

  it("opens newly created quest in modal immediately", async () => {
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
      expect(screen.getByRole("dialog", { name: /Quest details: Investigate reconnect jitter/ })).toBeInTheDocument();
    });
    expect(screen.queryByPlaceholderText("Quest title")).toBeNull();
  });
});
