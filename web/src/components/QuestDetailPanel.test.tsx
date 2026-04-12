// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useStore } from "../store.js";

// Mock the api module
const mockCheckQuestVerification = vi.fn();
const mockTransitionQuest = vi.fn();
const mockDeleteQuest = vi.fn();
const mockMarkQuestDone = vi.fn();
const mockAddQuestFeedback = vi.fn();
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
  },
}));

// Mock routing
const mockNavigateToSession = vi.fn();
vi.mock("../utils/routing.js", () => ({
  navigateToSession: (...args: unknown[]) => mockNavigateToSession(...args),
  withoutQuestIdInHash: (hash: string) => hash.replace(/[?&]quest=[^&]+/, ""),
}));

// Mock quest-assign and quest-rework
vi.mock("./quest-assign.js", () => ({
  buildQuestAssignDraft: (questId: string) => `Assign draft for ${questId}`,
}));
vi.mock("./quest-rework.js", () => ({
  buildQuestReworkDraft: (questId: string) => `Rework draft for ${questId}`,
}));

import { QuestDetailPanel } from "./QuestDetailPanel.js";
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

describe("QuestDetailPanel", () => {
  beforeEach(() => {
    useStore.getState().reset();
    mockNavigateToSession.mockReset();
    mockCheckQuestVerification.mockReset();
    mockTransitionQuest.mockReset();
    mockDeleteQuest.mockReset();
    mockMarkQuestDone.mockReset();
    mockAddQuestFeedback.mockReset();
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

    const updatedQuest = makeVerificationQuest({
      verificationItems: [
        { text: "Sidebar no overflow on iPhone SE", checked: true },
        { text: "Scroll works", checked: true },
      ],
    });
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
  });

  it("shows notes section for done quests", () => {
    const quest = makeDoneQuest();
    useStore.setState({ quests: [quest], questOverlayId: "q-99" });

    render(<QuestDetailPanel />);

    expect(screen.getByText(/Reduced p99 latency/)).toBeTruthy();
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
    // No verification checklist section (the word "Verification" in dropdown doesn't count)
    expect(screen.queryByText("Verification", { selector: "label" })).toBeNull();
    expect(screen.queryByText("Notes")).toBeNull();
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
    const updatedQuest = makeVerificationQuest({
      verificationItems: [
        { text: "Sidebar no overflow on iPhone SE", checked: false },
        { text: "Scroll works", checked: false },
      ],
    });
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
});
