// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { QuestmasterTask } from "../types.js";

const mockMarkQuestVerificationRead = vi.fn();
const mockMarkQuestVerificationInbox = vi.fn();

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
  navigateToSession: vi.fn(),
}));

vi.mock("../utils/questmaster-view-state.js", () => ({
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
  resetState({ quests: [inboxQuest, regularQuest] });
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
});
