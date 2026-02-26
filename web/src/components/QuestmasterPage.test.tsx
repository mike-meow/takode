// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { QuestmasterTask } from "../types.js";
import { buildQuestReworkDraft } from "./quest-rework.js";

const mockMarkQuestVerificationRead = vi.fn();
const mockMarkQuestVerificationInbox = vi.fn();
const mockNavigateToSession = vi.fn();

vi.mock("../api.js", () => ({
  api: {
    markQuestVerificationRead: (...args: unknown[]) =>
      mockMarkQuestVerificationRead(...args),
    markQuestVerificationInbox: (...args: unknown[]) =>
      mockMarkQuestVerificationInbox(...args),
    questImageUrl: (id: string) => `/api/quests/_images/${id}`,
  },
}));

vi.mock("../utils/routing.js", () => ({
  navigateToSession: (...args: unknown[]) =>
    mockNavigateToSession(...args),
}));

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
  sdkSessions: Array<{ sessionId: string; state: "connected"; cwd: string; createdAt: number; archived: boolean }>;
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

beforeEach(() => {
  vi.clearAllMocks();
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
  window.location.hash = "#/questmaster";
});

describe("QuestmasterPage verification inbox", () => {
  it("renders inbox quests separately from regular verification quests", () => {
    // Inbox should be a distinct section so reviewers can triage fresh updates first.
    render(<QuestmasterPage />);

    expect(screen.getByText("Verification Inbox")).toBeInTheDocument();
    expect(screen.getByText(/^Verification$/)).toBeInTheDocument();
    expect(screen.getByText("Inbox quest")).toBeInTheDocument();
    expect(screen.getByText("Regular verification quest")).toBeInTheDocument();
  });

  it("collapses and expands the verification inbox section", () => {
    // Inbox should behave like other grouped sections and support collapse toggling.
    render(<QuestmasterPage />);

    const inboxHeader = screen.getByRole("button", { name: /Verification Inbox/ });
    expect(screen.getByText("Inbox quest")).toBeInTheDocument();

    fireEvent.click(inboxHeader);
    expect(screen.queryByText("Inbox quest")).toBeNull();
    expect(screen.getByText("Regular verification quest")).toBeInTheDocument();

    fireEvent.click(inboxHeader);
    expect(screen.getByText("Inbox quest")).toBeInTheDocument();
  });

  it("marks an inbox quest as read", async () => {
    // Clicking Later should remove an inbox item from the inbox split.
    render(<QuestmasterPage />);

    fireEvent.click(screen.getByText("Inbox quest"));
    fireEvent.click(screen.getByRole("button", { name: "Later" }));

    await waitFor(() => {
      expect(mockMarkQuestVerificationRead).toHaveBeenCalledWith("q-1");
    });
    await waitFor(() => {
      const quest = mockState.quests.find((q) => q.questId === "q-1");
      expect(quest).toBeTruthy();
      expect((quest as { verificationInboxUnread?: boolean }).verificationInboxUnread).toBe(false);
    });
  });

  it("moves a regular verification quest into inbox", async () => {
    // Clicking Inbox should move a regular verification quest back to inbox.
    render(<QuestmasterPage />);

    fireEvent.click(screen.getByText("Regular verification quest"));
    fireEvent.click(screen.getByRole("button", { name: "Inbox" }));

    await waitFor(() => {
      expect(mockMarkQuestVerificationInbox).toHaveBeenCalledWith("q-2");
    });
    await waitFor(() => {
      const quest = mockState.quests.find((q) => q.questId === "q-2");
      expect(quest).toBeTruthy();
      expect((quest as { verificationInboxUnread?: boolean }).verificationInboxUnread).toBe(true);
    });
  });

  it("opens deep-linked quest in modal and closes it", () => {
    // Deep-linking should open the targeted quest in modal detail view.
    window.location.hash = "#/questmaster?quest=q-2";
    render(<QuestmasterPage />);

    expect(screen.getByRole("button", { name: "Close quest details" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Inbox" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close quest details" }));

    expect(screen.queryByRole("button", { name: "Close quest details" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Inbox" })).toBeNull();
  });

  it("shows collapsed-card metadata in the quest modal header", () => {
    // Modal should be a superset of card info: inbox/session/progress/feedback/time/tags.
    window.location.hash = "#/questmaster?quest=q-1";
    render(<QuestmasterPage />);

    const dialog = screen.getByRole("dialog", { name: /Quest details: Inbox quest/ });
    expect(within(dialog).getByText("Inbox")).toBeInTheDocument();
    expect(within(dialog).getByText("Session One")).toBeInTheDocument();
    expect(within(dialog).getByText("0/1")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("1 pending feedback")).toBeInTheDocument();
    expect(within(dialog).getByText("ui")).toBeInTheDocument();
  });

  it("prefills and navigates when clicking Rework with unaddressed feedback", () => {
    window.location.hash = "#/questmaster?quest=q-1";
    render(<QuestmasterPage />);

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

  it("disables Rework when all human feedback is addressed", () => {
    mockState.quests = mockState.quests.map((q) => (
      q.questId === "q-1"
        ? ({
            ...q,
            feedback: [{ author: "human", text: "done", ts: Date.now(), addressed: true }],
          } as QuestmasterTask)
        : q
    ));
    window.location.hash = "#/questmaster?quest=q-1";
    render(<QuestmasterPage />);

    const dialog = screen.getByRole("dialog", { name: /Quest details: Inbox quest/ });
    expect(within(dialog).getByRole("button", { name: "Rework" })).toBeDisabled();
  });

  it("closes lightbox first on Escape and keeps quest modal open", async () => {
    mockState.quests = mockState.quests.map((q) => (
      q.questId === "q-1"
        ? ({
            ...q,
            images: [{
              id: "img-1",
              filename: "proof.png",
              mimeType: "image/png",
              path: "/tmp/proof.png",
            }],
          } as QuestmasterTask)
        : q
    ));
    window.location.hash = "#/questmaster?quest=q-1";
    render(<QuestmasterPage />);

    const dialog = screen.getByRole("dialog", { name: /Quest details: Inbox quest/ });
    fireEvent.click(within(dialog).getByAltText("proof.png"));
    expect(screen.getByTestId("lightbox-backdrop")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByTestId("lightbox-backdrop")).toBeNull();
    });
    expect(screen.getByRole("dialog", { name: /Quest details: Inbox quest/ })).toBeInTheDocument();
  });
});
