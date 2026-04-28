// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { useStore } from "../store.js";

// Mock the api module
const mockCheckQuestVerification = vi.fn();
const mockTransitionQuest = vi.fn();
const mockDeleteQuest = vi.fn();
const mockMarkQuestDone = vi.fn();
const mockAddQuestFeedback = vi.fn();
const mockEditQuestFeedback = vi.fn();
const mockDeleteQuestFeedback = vi.fn();
const mockGetQuestHistory = vi.fn();
const mockGetQuestCommit = vi.fn();
const mockMarkNotificationDone = vi.fn();
const mockMarkAllNotificationsDone = vi.fn();
vi.mock("../api.js", () => ({
  api: {
    questImageUrl: (id: string) => `/api/quests/_images/${id}`,
    getSettings: vi.fn().mockResolvedValue({ editorConfig: { editor: "none" } }),
    openVsCodeRemoteFile: vi.fn(),
    checkQuestVerification: (...args: unknown[]) => mockCheckQuestVerification(...args),
    transitionQuest: (...args: unknown[]) => mockTransitionQuest(...args),
    deleteQuest: (...args: unknown[]) => mockDeleteQuest(...args),
    markQuestDone: (...args: unknown[]) => mockMarkQuestDone(...args),
    addQuestFeedback: (...args: unknown[]) => mockAddQuestFeedback(...args),
    editQuestFeedback: (...args: unknown[]) => mockEditQuestFeedback(...args),
    deleteQuestFeedback: (...args: unknown[]) => mockDeleteQuestFeedback(...args),
    getQuestHistory: (...args: unknown[]) => mockGetQuestHistory(...args),
    getQuestCommit: (...args: unknown[]) => mockGetQuestCommit(...args),
    markNotificationDone: (...args: unknown[]) => mockMarkNotificationDone(...args),
    markAllNotificationsDone: (...args: unknown[]) => mockMarkAllNotificationsDone(...args),
  },
}));

// Mock routing
const mockNavigateToSession = vi.fn();
vi.mock("../utils/routing.js", () => ({
  navigateToSession: (...args: unknown[]) => mockNavigateToSession(...args),
  withoutQuestIdInHash: (hash: string) => hash.replace(/[?&]quest=[^&]+/, ""),
  withQuestIdInHash: (_hash: string, questId: string) => `#/?quest=${questId}`,
}));

// Mock quest-assign and quest-rework
vi.mock("./quest-assign.js", () => ({
  buildQuestAssignDraft: (questId: string) => `Assign draft for ${questId}`,
}));
vi.mock("./quest-rework.js", () => ({
  buildQuestReworkDraft: (questId: string) => `Rework draft for ${questId}`,
}));

import { QuestDetailPanel } from "./QuestDetailPanel.js";
import { NotificationChip } from "./NotificationChip.js";
import type { QuestmasterTask, QuestVerificationItem } from "../types.js";

// Minimal quest fixtures for testing
function makeVerificationQuest(overrides?: Partial<QuestmasterTask>): QuestmasterTask {
  return {
    id: "q-42-v3",
    questId: "q-42",
    version: 3,
    title: "Fix mobile sidebar overflow",
    status: "needs_verification",
    description: "The sidebar overflows on narrow screens.\n\n## Steps\n1. Add wrapper\n2. Test",
    createdAt: Date.now() - 86400000,
    updatedAt: Date.now() - 3600000,
    sessionId: "session-abc",
    claimedAt: Date.now() - 43200000,
    tags: ["ui", "mobile"],
    verificationItems: [
      { text: "Sidebar no overflow on iPhone SE", checked: true },
      { text: "Scroll works", checked: false },
    ],
    feedback: [
      { author: "human", text: "Check iPad mini too", ts: Date.now() - 7200000, addressed: true },
      {
        author: "agent",
        text: "Confirmed working on iPad mini.",
        ts: Date.now() - 3600000,
        authorSessionId: "session-abc",
      },
    ],
    ...overrides,
  } as QuestmasterTask;
}

function makeDoneQuest(): QuestmasterTask {
  return {
    id: "q-99-v2",
    questId: "q-99",
    version: 2,
    title: "Optimize DB queries",
    status: "done",
    description: "Query optimization for the dashboard.",
    createdAt: Date.now() - 172800000,
    completedAt: Date.now() - 3600000,
    notes: "Reduced p99 latency by 40%.",
    verificationItems: [{ text: "Dashboard loads under 2s", checked: true }],
    claimedAt: Date.now() - 86400000,
  } as QuestmasterTask;
}

function advanceQuestUpdate<T extends QuestmasterTask>(quest: T, deltaMs = 1): T {
  const baseUpdatedAt = quest.updatedAt ?? ("completedAt" in quest ? quest.completedAt : quest.createdAt);
  return {
    ...quest,
    updatedAt: baseUpdatedAt + deltaMs,
  } as T;
}

describe("QuestDetailPanel", () => {
  beforeEach(() => {
    useStore.getState().reset();
    mockNavigateToSession.mockReset();
    mockCheckQuestVerification.mockReset();
    mockTransitionQuest.mockReset();
    mockDeleteQuest.mockReset();
    mockMarkQuestDone.mockReset();
    mockAddQuestFeedback.mockReset();
    mockEditQuestFeedback.mockReset();
    mockDeleteQuestFeedback.mockReset();
    mockGetQuestHistory.mockReset();
    mockGetQuestCommit.mockReset();
    mockMarkNotificationDone.mockReset();
    mockMarkAllNotificationsDone.mockReset();
    document.body.style.overflow = "";
  });

  it("renders nothing when questOverlayId is null", () => {
    const { container } = render(<QuestDetailPanel />);
    expect(container.innerHTML).toBe("");
    expect(screen.queryByTestId("quest-detail-panel")).toBeNull();
  });

  it("renders the panel when questOverlayId matches a quest in the store", () => {
    const quest = makeVerificationQuest();
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });

    render(<QuestDetailPanel />);

    // Panel should be visible with the quest title
    expect(screen.getByTestId("quest-detail-panel")).toBeTruthy();
    expect(screen.getByText("Fix mobile sidebar overflow")).toBeTruthy();
    // Status badge
    expect(screen.getAllByText("Verification").length).toBeGreaterThanOrEqual(1);
    // Tags
    expect(screen.getByText("ui")).toBeTruthy();
    expect(screen.getByText("mobile")).toBeTruthy();
  });

  it("shows the vertical Journey detail with phase notes when the quest is active on the board", () => {
    const quest = makeVerificationQuest({ questId: "q-42", status: "in_progress" });
    useStore.setState({
      quests: [quest],
      questOverlayId: "q-42",
      sessionBoards: new Map([
        [
          "leader-1",
          [
            {
              questId: "q-42",
              status: "IMPLEMENTING",
              updatedAt: 1,
              journey: {
                presetId: "full-code",
                phaseIds: ["alignment", "implement", "code-review", "port"],
                currentPhaseId: "implement",
                phaseNotes: {
                  "2": "Inspect only the follow-up diff",
                },
              },
            },
          ],
        ],
      ]),
    });

    render(<QuestDetailPanel />);

    const timeline = screen.getByTestId("quest-journey-timeline");
    expect(timeline).toHaveAttribute("data-journey-mode", "active");
    expect(screen.getByTestId("quest-journey-detail-list")).toBeInTheDocument();
    expect(within(timeline).getByText("Alignment")).toBeInTheDocument();
    expect(within(timeline).getByText("Implement")).toBeInTheDocument();
    expect(within(timeline).getByText("Code Review")).toBeInTheDocument();
    expect(within(timeline).getByText("Port")).toBeInTheDocument();
    expect(within(timeline).getByText("Inspect only the follow-up diff")).toBeInTheDocument();
    expect(within(timeline).getByText("current")).toBeInTheDocument();
    expect(within(timeline).getByText("Code Review").closest("li")).toHaveAttribute("data-phase-color", "violet");
  });

  it("shows proposed board Journeys as preview details without current phase semantics", () => {
    const quest = makeVerificationQuest({ questId: "q-924", status: "refined" });
    useStore.setState({
      quests: [quest],
      questOverlayId: "q-924",
      sessionBoards: new Map([
        [
          "leader-1",
          [
            {
              questId: "q-924",
              status: "PROPOSED",
              updatedAt: 1,
              journey: {
                mode: "proposed",
                presetId: "full-code",
                phaseIds: ["alignment", "implement", "code-review", "port"],
                activePhaseIndex: 1,
                currentPhaseId: "implement",
                phaseNotes: {
                  "0": "Ask user to approve this Journey before dispatch",
                },
              },
            },
          ],
        ],
      ]),
    });

    render(<QuestDetailPanel />);

    const timeline = screen.getByTestId("quest-journey-timeline");
    expect(timeline).toHaveAttribute("data-journey-mode", "proposed");
    expect(within(timeline).getByText("Proposed Journey")).toBeInTheDocument();
    expect(within(timeline).getByText("Ask user to approve this Journey before dispatch")).toBeInTheDocument();
    expect(within(timeline).getAllByText("preview")).toHaveLength(4);
    expect(within(timeline).queryByText("current")).not.toBeInTheDocument();
    for (const phaseRow of timeline.querySelectorAll("li")) {
      expect(phaseRow).toHaveAttribute("data-phase-current", "false");
      expect(phaseRow).toHaveAttribute("data-phase-state", "proposed");
    }
  });

  it("does not show the Journey timeline when the quest is not active on the board", () => {
    const quest = makeVerificationQuest({ questId: "q-42", status: "in_progress" });
    useStore.setState({
      quests: [quest],
      questOverlayId: "q-42",
      sessionBoards: new Map([
        ["leader-1", [{ questId: "q-99", status: "IMPLEMENTING", updatedAt: 1, journey: { phaseIds: ["implement"] } }]],
      ]),
    });

    render(<QuestDetailPanel />);

    expect(screen.queryByTestId("quest-journey-timeline")).toBeNull();
  });

  it("renders nothing when questOverlayId does not match any quest", () => {
    useStore.setState({ quests: [], questOverlayId: "q-999" });

    const { container } = render(<QuestDetailPanel />);
    expect(container.innerHTML).toBe("");
  });

  it("closes on Escape key press", () => {
    const quest = makeVerificationQuest();
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });

    render(<QuestDetailPanel />);
    expect(screen.getByTestId("quest-detail-panel")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(useStore.getState().questOverlayId).toBeNull();
  });

  it("closes on backdrop click", () => {
    const quest = makeVerificationQuest();
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });

    render(<QuestDetailPanel />);

    fireEvent.click(screen.getByTestId("quest-detail-panel-backdrop"));
    expect(useStore.getState().questOverlayId).toBeNull();
  });

  it("closes on close button click", () => {
    const quest = makeVerificationQuest();
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });

    render(<QuestDetailPanel />);

    fireEvent.click(screen.getByTestId("quest-detail-panel-close"));
    expect(useStore.getState().questOverlayId).toBeNull();
  });

  it("keeps the notifications popover open after closing the quest modal from its close button", () => {
    const quest = makeVerificationQuest();
    useStore.setState({
      quests: [quest],
      questOverlayId: null,
      sessionNotifications: new Map([
        [
          "s1",
          [
            {
              id: "notif-1",
              category: "review",
              summary: "q-42 ready for review",
              timestamp: Date.now(),
              messageId: "msg-1",
              done: false,
            },
          ],
        ],
      ]),
    });

    render(
      <>
        <NotificationChip sessionId="s1" />
        <QuestDetailPanel />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Notification inbox: 1 review notification" }));
    fireEvent.click(screen.getByRole("link", { name: "q-42" }));
    expect(screen.getByTestId("quest-detail-panel")).toBeTruthy();

    fireEvent.click(screen.getByTestId("quest-detail-panel-close"));

    expect(useStore.getState().questOverlayId).toBeNull();
    expect(screen.getByRole("dialog", { name: "Notification inbox" })).toBeTruthy();
  });

  it("keeps the notifications popover open after closing the quest modal from the backdrop", () => {
    const quest = makeVerificationQuest();
    useStore.setState({
      quests: [quest],
      questOverlayId: null,
      sessionNotifications: new Map([
        [
          "s1",
          [
            {
              id: "notif-1",
              category: "review",
              summary: "q-42 ready for review",
              timestamp: Date.now(),
              messageId: "msg-1",
              done: false,
            },
          ],
        ],
      ]),
    });

    render(
      <>
        <NotificationChip sessionId="s1" />
        <QuestDetailPanel />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Notification inbox: 1 review notification" }));
    fireEvent.click(screen.getByRole("link", { name: "q-42" }));
    expect(screen.getByTestId("quest-detail-panel")).toBeTruthy();

    fireEvent.mouseDown(screen.getByTestId("quest-detail-panel-backdrop"));
    fireEvent.click(screen.getByTestId("quest-detail-panel-backdrop"));

    expect(useStore.getState().questOverlayId).toBeNull();
    expect(screen.getByRole("dialog", { name: "Notification inbox" })).toBeTruthy();
  });

  it("keeps the notifications popover open after closing the quest modal with Escape", () => {
    const quest = makeVerificationQuest();
    useStore.setState({
      quests: [quest],
      questOverlayId: null,
      sessionNotifications: new Map([
        [
          "s1",
          [
            {
              id: "notif-1",
              category: "review",
              summary: "q-42 ready for review",
              timestamp: Date.now(),
              messageId: "msg-1",
              done: false,
            },
          ],
        ],
      ]),
    });

    render(
      <>
        <NotificationChip sessionId="s1" />
        <QuestDetailPanel />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Notification inbox: 1 review notification" }));
    fireEvent.click(screen.getByRole("link", { name: "q-42" }));
    expect(screen.getByTestId("quest-detail-panel")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(useStore.getState().questOverlayId).toBeNull();
    expect(screen.getByRole("dialog", { name: "Notification inbox" })).toBeTruthy();
  });

  it("shows description rendered as markdown", () => {
    const quest = makeVerificationQuest();
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });

    render(<QuestDetailPanel />);

    expect(screen.getByText(/The sidebar overflows/)).toBeTruthy();
  });

  it("renders verification items with correct checked state", () => {
    const quest = makeVerificationQuest();
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });

    render(<QuestDetailPanel />);

    expect(screen.getByText("Sidebar no overflow on iPhone SE")).toBeTruthy();
    expect(screen.getByText("Scroll works")).toBeTruthy();

    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes[0]).toHaveProperty("checked", true);
    expect(checkboxes[1]).toHaveProperty("checked", false);
  });

  it("toggles verification checkbox via API and updates store", async () => {
    const quest = makeVerificationQuest();
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });

    const updatedQuest = advanceQuestUpdate(
      makeVerificationQuest({
        verificationItems: [
          { text: "Sidebar no overflow on iPhone SE", checked: true },
          { text: "Scroll works", checked: true },
        ],
      }),
    );
    mockCheckQuestVerification.mockResolvedValue(updatedQuest);

    render(<QuestDetailPanel />);

    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[1]);

    expect(mockCheckQuestVerification).toHaveBeenCalledWith("q-42", 1, true);

    await waitFor(() => {
      const storeQuest = useStore.getState().quests.find((q) => q.questId === "q-42");
      expect(
        (storeQuest as QuestmasterTask & { verificationItems: QuestVerificationItem[] }).verificationItems[1].checked,
      ).toBe(true);
    });
  });

  it("keeps checkbox unchanged when API call fails", async () => {
    const quest = makeVerificationQuest();
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });

    mockCheckQuestVerification.mockRejectedValue(new Error("Network error"));

    render(<QuestDetailPanel />);

    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[1]);

    await waitFor(() => {
      expect(mockCheckQuestVerification).toHaveBeenCalled();
    });

    const storeQuest = useStore.getState().quests.find((q) => q.questId === "q-42");
    expect(
      (storeQuest as QuestmasterTask & { verificationItems: QuestVerificationItem[] }).verificationItems[1].checked,
    ).toBe(false);
  });

  it("shows feedback entries with author labels", () => {
    const quest = makeVerificationQuest();
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });

    render(<QuestDetailPanel />);

    expect(screen.getByText("Feedback")).toBeTruthy();
    expect(screen.getByText("Check iPad mini too")).toBeTruthy();
    expect(screen.getByText("Confirmed working on iPad mini.")).toBeTruthy();
    expect(screen.getByText("addressed")).toBeTruthy();
    expect(screen.getByPlaceholderText("Leave feedback...")).toBeTruthy();
  });

  it("shows legacy backup history when requested", async () => {
    const quest = makeVerificationQuest();
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });
    mockGetQuestHistory.mockResolvedValue({
      mode: "legacy_backup",
      backupDir: "/tmp/legacy-backup",
      entries: [
        {
          id: "q-42-v1",
          questId: "q-42",
          version: 1,
          title: "Initial quest",
          status: "idea",
          createdAt: Date.now() - 86400000,
        },
      ],
    });

    render(<QuestDetailPanel />);

    fireEvent.click(screen.getByText("show history"));

    await waitFor(() => {
      expect(screen.getByText("Legacy backup history")).toBeTruthy();
      expect(screen.getByText("Initial quest")).toBeTruthy();
    });
  });

  it("shows edit controls for human and agent feedback, with delete only for agent feedback", () => {
    const quest = makeVerificationQuest();
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });

    render(<QuestDetailPanel />);

    expect(screen.getByLabelText("Edit feedback 1")).toBeTruthy();
    expect(screen.queryByLabelText("Delete agent feedback 1")).toBeNull();

    expect(screen.getByLabelText("Edit feedback 2")).toBeTruthy();
    expect(screen.getByLabelText("Delete agent feedback 2")).toBeTruthy();
  });

  it("edits human feedback and updates the quest in store", async () => {
    const quest = makeVerificationQuest();
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });
    const updatedQuest = advanceQuestUpdate(
      makeVerificationQuest({
        feedback: [
          { author: "human", text: "Check iPad mini and Safari too", ts: Date.now() - 7200000, addressed: true },
          {
            author: "agent",
            text: "Confirmed working on iPad mini.",
            ts: Date.now() - 3600000,
            authorSessionId: "session-abc",
          },
        ],
      }),
    );
    mockEditQuestFeedback.mockResolvedValue(updatedQuest);

    render(<QuestDetailPanel />);

    fireEvent.click(screen.getByLabelText("Edit feedback 1"));
    fireEvent.change(screen.getByDisplayValue("Check iPad mini too"), {
      target: { value: "Check iPad mini and Safari too" },
    });
    fireEvent.click(screen.getByText("Save"));

    expect(mockEditQuestFeedback).toHaveBeenCalledWith("q-42", 0, {
      text: "Check iPad mini and Safari too",
      images: [],
    });

    await waitFor(() => {
      expect(useStore.getState().quests.find((q) => q.questId === "q-42")).toMatchObject({
        feedback: expect.arrayContaining([expect.objectContaining({ text: "Check iPad mini and Safari too" })]),
      });
    });
  });

  it("clears edited agent feedback attachments when the last image is removed", async () => {
    // Removing the last attachment should send an explicit empty images array instead of silently preserving it.
    const image = { id: "img-1", filename: "attachment.png", mimeType: "image/png", path: "/tmp/attachment.png" };
    const quest = makeVerificationQuest({
      feedback: [
        { author: "human", text: "Check iPad mini too", ts: Date.now() - 7200000, addressed: true },
        {
          author: "agent",
          text: "Confirmed working on iPad mini.",
          ts: Date.now() - 3600000,
          authorSessionId: "session-abc",
          images: [image],
        },
      ],
    });
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });
    const updatedQuest = advanceQuestUpdate(
      makeVerificationQuest({
        feedback: [
          { author: "human", text: "Check iPad mini too", ts: Date.now() - 7200000, addressed: true },
          {
            author: "agent",
            text: "Confirmed working on iPad mini.",
            ts: Date.now() - 3600000,
            authorSessionId: "session-abc",
          },
        ],
      }),
    );
    mockEditQuestFeedback.mockResolvedValue(updatedQuest);

    render(<QuestDetailPanel />);

    fireEvent.click(screen.getByLabelText("Edit feedback 2"));
    fireEvent.click(screen.getByLabelText("Remove feedback image attachment.png"));
    fireEvent.click(screen.getByText("Save"));

    expect(mockEditQuestFeedback).toHaveBeenCalledWith("q-42", 1, {
      text: "Confirmed working on iPad mini.",
      images: [],
    });
  });

  it("requires explicit confirmation before deleting agent feedback", async () => {
    const quest = makeVerificationQuest();
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });
    const updatedQuest = advanceQuestUpdate(
      makeVerificationQuest({
        feedback: [{ author: "human", text: "Check iPad mini too", ts: Date.now() - 7200000, addressed: true }],
      }),
    );
    mockDeleteQuestFeedback.mockResolvedValue(updatedQuest);

    render(<QuestDetailPanel />);

    fireEvent.click(screen.getByLabelText("Delete agent feedback 2"));

    // Deletion stays two-step so the inline trash affordance is safe to expose.
    expect(screen.getByLabelText("Confirm delete agent feedback 2")).toBeTruthy();
    expect(screen.getByLabelText("Cancel delete agent feedback 2")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Confirm delete agent feedback 2"));

    expect(mockDeleteQuestFeedback).toHaveBeenCalledWith("q-42", 1);

    await waitFor(() => {
      const storeQuest = useStore.getState().quests.find((q) => q.questId === "q-42");
      expect(storeQuest).toMatchObject({
        feedback: [expect.objectContaining({ author: "human", text: "Check iPad mini too" })],
      });
    });
  });

  it("keeps the panel open when Escape dismisses inline feedback edit state", () => {
    // Escape should first cancel inline editing rather than closing the whole quest overlay.
    const quest = makeVerificationQuest();
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });

    render(<QuestDetailPanel />);

    fireEvent.click(screen.getByLabelText("Edit feedback 2"));
    expect(screen.getByText("Save")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByText("Save")).toBeNull();
    expect(useStore.getState().questOverlayId).toBe("q-42");
  });

  it("keeps the panel open when inline delete confirmation is cancelled", () => {
    // Cancel should dismiss the dangerous inline delete state without closing the quest itself.
    const quest = makeVerificationQuest();
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });

    render(<QuestDetailPanel />);

    fireEvent.click(screen.getByLabelText("Delete agent feedback 2"));
    fireEvent.click(screen.getByLabelText("Cancel delete agent feedback 2"));

    expect(screen.queryByLabelText("Confirm delete agent feedback 2")).toBeNull();
    expect(useStore.getState().questOverlayId).toBe("q-42");
  });

  it("shows notes section for done quests", () => {
    const quest = makeDoneQuest();
    useStore.setState({ quests: [quest], questOverlayId: "q-99" });

    render(<QuestDetailPanel />);

    expect(screen.getByText(/Reduced p99 latency/)).toBeTruthy();
    expect(screen.getByPlaceholderText("Leave feedback...")).toBeTruthy();
  });

  it("submits feedback from a done quest and updates the quest in store", async () => {
    // q-328 regression guard: the composer must not just be visible on a
    // previously gated state like "done" — it must still submit through the
    // normal feedback path and refresh the quest thread in store.
    const quest = makeDoneQuest();
    useStore.setState({ quests: [quest], questOverlayId: "q-99" });
    const updatedQuest = advanceQuestUpdate({
      ...makeDoneQuest(),
      feedback: [{ author: "human", text: "Please note the migration impact.", ts: Date.now() }],
    } as QuestmasterTask);
    mockAddQuestFeedback.mockResolvedValue(updatedQuest);

    render(<QuestDetailPanel />);

    fireEvent.change(screen.getByPlaceholderText("Leave feedback..."), {
      target: { value: "Please note the migration impact." },
    });
    fireEvent.click(screen.getByText("Add Feedback"));

    expect(mockAddQuestFeedback).toHaveBeenCalledWith("q-99", "Please note the migration impact.", "human", undefined);

    await waitFor(() => {
      expect(useStore.getState().quests.find((q) => q.questId === "q-99")).toMatchObject({
        feedback: [expect.objectContaining({ text: "Please note the migration impact." })],
      });
    });
  });

  it("shows verification progress in the header", () => {
    const quest = makeVerificationQuest();
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });

    render(<QuestDetailPanel />);

    expect(screen.getByText("1/2")).toBeTruthy();
  });

  it("shows images with clickable thumbnails", () => {
    const quest = makeVerificationQuest({
      images: [{ id: "img-1", filename: "screenshot.png", mimeType: "image/png", path: "/path/to/img-1.png" }],
    });
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });

    render(<QuestDetailPanel />);

    const img = screen.getByAltText("screenshot.png");
    expect(img).toBeTruthy();
    expect(img.getAttribute("src")).toBe("/api/quests/_images/img-1");
  });

  it("locks body scroll when open", () => {
    const quest = makeVerificationQuest();
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });

    render(<QuestDetailPanel />);

    expect(document.body.style.overflow).toBe("hidden");
  });

  it("closes lightbox first on Escape, keeping the panel open", () => {
    const quest = makeVerificationQuest({
      images: [{ id: "img-1", filename: "screenshot.png", mimeType: "image/png", path: "/path/to/img-1.png" }],
    });
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });

    render(<QuestDetailPanel />);

    const img = screen.getByAltText("screenshot.png");
    fireEvent.click(img);
    expect(screen.getByTestId("lightbox-backdrop")).toBeTruthy();

    // First Escape closes lightbox, not panel
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("lightbox-backdrop")).toBeNull();
    expect(useStore.getState().questOverlayId).toBe("q-42");

    // Second Escape closes panel
    fireEvent.keyDown(document, { key: "Escape" });
    expect(useStore.getState().questOverlayId).toBeNull();
  });

  it("renders a cancelled quest with red dot styling", () => {
    const quest = makeDoneQuest();
    (quest as Record<string, unknown>).cancelled = true;
    useStore.setState({ quests: [quest], questOverlayId: "q-99" });

    render(<QuestDetailPanel />);

    expect(screen.getByText("Optimize DB queries")).toBeTruthy();
    expect(screen.getByTestId("quest-detail-panel")).toBeTruthy();
  });

  it("renders parent ID badge when quest has a parent", () => {
    const quest = makeVerificationQuest({ parentId: "q-10" });
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });

    render(<QuestDetailPanel />);

    expect(screen.getByText("sub:q-10")).toBeTruthy();
  });

  it("renders a minimal quest without optional fields", () => {
    const quest: QuestmasterTask = {
      id: "q-5-v1",
      questId: "q-5",
      version: 1,
      title: "Bare idea quest",
      status: "idea",
      createdAt: Date.now() - 60000,
    } as QuestmasterTask;
    useStore.setState({ quests: [quest], questOverlayId: "q-5" });

    render(<QuestDetailPanel />);

    expect(screen.getByText("Bare idea quest")).toBeTruthy();
    // "Idea" appears in both the status badge and the select dropdown
    expect(screen.getAllByText("Idea").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByPlaceholderText("Leave feedback...")).toBeTruthy();
    expect(screen.getByText("Add Feedback")).toBeTruthy();
    // No verification checklist section (the word "Verification" in dropdown doesn't count)
    expect(screen.queryByText("Verification", { selector: "label" })).toBeNull();
    expect(screen.queryByText("Notes")).toBeNull();
  });

  it("shows the feedback composer for refined quests", () => {
    // Refined quests were also previously gated out by the status check, so
    // keep a direct visibility assertion for that lifecycle state.
    const quest: QuestmasterTask = {
      id: "q-6-v1",
      questId: "q-6",
      version: 1,
      title: "Ready for implementation",
      status: "refined",
      description: "Scoped and ready to pick up.",
      createdAt: Date.now() - 120000,
    } as QuestmasterTask;
    useStore.setState({ quests: [quest], questOverlayId: "q-6" });

    render(<QuestDetailPanel />);

    expect(screen.getByText("Ready for implementation")).toBeTruthy();
    expect(screen.getByPlaceholderText("Leave feedback...")).toBeTruthy();
    expect(screen.getByText("Add Feedback")).toBeTruthy();
  });

  // ─── Action button tests (new in QuestDetailPanel) ──────────────────

  it("shows Edit button in the action bar", () => {
    const quest = makeVerificationQuest();
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });

    render(<QuestDetailPanel />);

    expect(screen.getByText("Edit")).toBeTruthy();
  });

  it("shows status dropdown with current status", () => {
    const quest = makeVerificationQuest();
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });

    render(<QuestDetailPanel />);

    // Status dropdown should be a select element with current status
    const select = screen.getByRole("combobox");
    expect(select).toBeTruthy();
  });

  it("shows Delete button that requires confirmation", () => {
    const quest = makeVerificationQuest();
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });

    render(<QuestDetailPanel />);

    const deleteBtn = screen.getByText("Delete");
    expect(deleteBtn).toBeTruthy();

    // Click Delete -- should show "Confirm Delete"
    fireEvent.click(deleteBtn);
    expect(screen.getByText("Confirm Delete")).toBeTruthy();
    expect(screen.getByText("Cancel")).toBeTruthy();
  });

  it("shows Finish Quest button for non-done quests", () => {
    const quest = makeVerificationQuest();
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });

    render(<QuestDetailPanel />);

    expect(screen.getByText("Finish Quest")).toBeTruthy();
  });

  it("hides Finish Quest button for done quests", () => {
    const quest = makeDoneQuest();
    useStore.setState({ quests: [quest], questOverlayId: "q-99" });

    render(<QuestDetailPanel />);

    expect(screen.queryByText("Finish Quest")).toBeNull();
  });

  it("calls deleteQuest API on confirm delete and closes panel", async () => {
    const quest = makeVerificationQuest();
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });
    mockDeleteQuest.mockResolvedValue(undefined);

    render(<QuestDetailPanel />);

    // Click Delete, then Confirm Delete
    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(screen.getByText("Confirm Delete"));

    expect(mockDeleteQuest).toHaveBeenCalledWith("q-42");

    await waitFor(() => {
      // Panel should close after delete
      expect(useStore.getState().questOverlayId).toBeNull();
      // Quest should be removed from store
      expect(useStore.getState().quests.find((q) => q.questId === "q-42")).toBeUndefined();
    });
  });

  it("calls markQuestDone API on Finish Quest and closes panel", async () => {
    const quest = makeVerificationQuest();
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });
    const doneQuest = makeVerificationQuest({ status: "done" });
    mockMarkQuestDone.mockResolvedValue(doneQuest);

    render(<QuestDetailPanel />);

    fireEvent.click(screen.getByText("Finish Quest"));

    expect(mockMarkQuestDone).toHaveBeenCalledWith("q-42");

    await waitFor(() => {
      // Panel should close after marking done
      expect(useStore.getState().questOverlayId).toBeNull();
    });
  });

  it("unchecks a previously checked verification item via API", async () => {
    // Setup: quest with item 0 already checked
    const quest = makeVerificationQuest();
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });

    // Mock API to return quest with item 0 now unchecked
    const updatedQuest = advanceQuestUpdate(
      makeVerificationQuest({
        verificationItems: [
          { text: "Sidebar no overflow on iPhone SE", checked: false },
          { text: "Scroll works", checked: false },
        ],
      }),
    );
    mockCheckQuestVerification.mockResolvedValue(updatedQuest);

    render(<QuestDetailPanel />);

    // Click the checked checkbox (index 0) to uncheck it
    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[0]);

    // API should be called with checked=false (toggling from true to false)
    expect(mockCheckQuestVerification).toHaveBeenCalledWith("q-42", 0, false);

    // After API resolves, store should reflect the unchecked state
    await waitFor(() => {
      const storeQuest = useStore.getState().quests.find((q) => q.questId === "q-42");
      expect(
        (storeQuest as QuestmasterTask & { verificationItems: QuestVerificationItem[] }).verificationItems[0].checked,
      ).toBe(false);
    });
  });

  it("renders commit chips and navigates between commit diffs in the modal", async () => {
    const firstSha = "abc1234def567890";
    const secondSha = "deadbeeffeedcafe";
    const quest = makeVerificationQuest({ commitShas: [firstSha, secondSha] } as Partial<QuestmasterTask>);
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });
    mockGetQuestCommit
      .mockResolvedValueOnce({
        sha: firstSha,
        shortSha: firstSha.slice(0, 7),
        message: "First ported commit",
        timestamp: Date.now(),
        additions: 12,
        deletions: 4,
        diff: `diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n`,
        available: true,
      })
      .mockResolvedValueOnce({
        sha: secondSha,
        shortSha: secondSha.slice(0, 7),
        message: "Second ported commit",
        timestamp: Date.now(),
        additions: 3,
        deletions: 1,
        diff: `diff --git a/other.ts b/other.ts\n--- a/other.ts\n+++ b/other.ts\n@@ -1 +1 @@\n-before\n+after\n`,
        available: true,
      });

    render(<QuestDetailPanel />);

    fireEvent.click(screen.getByLabelText(`Open commit ${firstSha.slice(0, 7)}`));

    await waitFor(() => {
      expect(mockGetQuestCommit).toHaveBeenCalledWith("q-42", firstSha);
    });
    expect(screen.getByTestId("quest-commit-modal")).toBeTruthy();
    expect(screen.getByText("First ported commit")).toBeTruthy();
    expect(screen.getByText("+12 additions")).toBeTruthy();
    expect(screen.getByText("-4 deletions")).toBeTruthy();

    fireEvent.click(screen.getByText("Next"));

    await waitFor(() => {
      expect(mockGetQuestCommit).toHaveBeenCalledWith("q-42", secondSha);
    });
    expect(screen.getByText("Second ported commit")).toBeTruthy();
    expect(screen.getByText("+3 additions")).toBeTruthy();
    expect(screen.getByText("-1 deletions")).toBeTruthy();
  });

  it("shows a graceful unavailable state when a stored commit cannot be loaded", async () => {
    const sha = "abc1234def567890";
    const quest = makeVerificationQuest({ commitShas: [sha] } as Partial<QuestmasterTask>);
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });
    mockGetQuestCommit.mockResolvedValueOnce({
      sha,
      available: false,
      reason: "commit_not_available",
    });

    render(<QuestDetailPanel />);

    fireEvent.click(screen.getByLabelText(`Open commit ${sha.slice(0, 7)}`));

    await waitFor(() => {
      expect(mockGetQuestCommit).toHaveBeenCalledWith("q-42", sha);
    });
    expect(screen.getByText("Commit not available")).toBeTruthy();
    expect(screen.getByText("This commit is no longer available in local git history.")).toBeTruthy();
  });
});
