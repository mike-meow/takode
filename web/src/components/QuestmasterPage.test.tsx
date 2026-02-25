// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { QuestmasterTask } from "../types.js";

const mockMarkQuestVerificationRead = vi.fn().mockResolvedValue({});

vi.mock("../api.js", () => ({
  api: {
    markQuestVerificationRead: (...args: unknown[]) =>
      mockMarkQuestVerificationRead(...args),
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
  resetState({
    quests: [
      buildVerificationQuest({
        id: "q-1-v3",
        questId: "q-1",
        title: "Inbox quest",
        verificationInboxUnread: true,
      }),
      buildVerificationQuest({
        id: "q-2-v3",
        questId: "q-2",
        title: "Regular verification quest",
        verificationInboxUnread: false,
      }),
    ],
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
    // Clicking Read should call the dedicated API and then refetch authoritative data.
    render(<QuestmasterPage />);

    fireEvent.click(screen.getByText("Inbox quest"));
    fireEvent.click(screen.getByRole("button", { name: "Read" }));

    await waitFor(() => {
      expect(mockMarkQuestVerificationRead).toHaveBeenCalledWith("q-1");
    });
    await waitFor(() => {
      expect(mockState.refreshQuests).toHaveBeenCalledTimes(2);
    });
  });
});
