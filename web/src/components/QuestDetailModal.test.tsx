// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { useStore } from "../store.js";

// Mock the api module -- questImageUrl is needed for images
vi.mock("../api.js", () => ({
  api: {
    questImageUrl: (id: string) => `/api/quests/_images/${id}`,
    getSettings: vi.fn().mockResolvedValue({ editorConfig: { editor: "none" } }),
    openVsCodeRemoteFile: vi.fn(),
  },
}));

// Mock navigateTo for the "Open in Questmaster" button
const mockNavigateTo = vi.fn();
vi.mock("../utils/navigation.js", () => ({
  navigateTo: (...args: unknown[]) => mockNavigateTo(...args),
}));

import { QuestDetailModal } from "./QuestDetailModal.js";
import type { QuestmasterTask } from "../types.js";

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
      { author: "agent", text: "Confirmed working on iPad mini.", ts: Date.now() - 3600000, authorSessionId: "session-abc" },
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
    verificationItems: [
      { text: "Dashboard loads under 2s", checked: true },
    ],
    claimedAt: Date.now() - 86400000,
  } as QuestmasterTask;
}

describe("QuestDetailModal", () => {
  beforeEach(() => {
    useStore.getState().reset();
    mockNavigateTo.mockReset();
    document.body.style.overflow = "";
  });

  it("renders nothing when questOverlayId is null", () => {
    // No quest overlay open
    const { container } = render(<QuestDetailModal />);
    expect(container.innerHTML).toBe("");
    expect(screen.queryByTestId("quest-detail-modal")).toBeNull();
  });

  it("renders the modal when questOverlayId matches a quest in the store", () => {
    const quest = makeVerificationQuest();
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });

    render(<QuestDetailModal />);

    // Modal should be visible with the quest title
    expect(screen.getByTestId("quest-detail-modal")).toBeTruthy();
    expect(screen.getByText("Fix mobile sidebar overflow")).toBeTruthy();
    // Status badge should show (the quest status "needs_verification" renders as "Verification")
    expect(screen.getAllByText("Verification").length).toBeGreaterThanOrEqual(1);
    // Tags
    expect(screen.getByText("ui")).toBeTruthy();
    expect(screen.getByText("mobile")).toBeTruthy();
  });

  it("renders nothing when questOverlayId does not match any quest", () => {
    // Store has no quests
    useStore.setState({ quests: [], questOverlayId: "q-999" });

    const { container } = render(<QuestDetailModal />);
    expect(container.innerHTML).toBe("");
  });

  it("closes on Escape key press", () => {
    const quest = makeVerificationQuest();
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });

    render(<QuestDetailModal />);
    expect(screen.getByTestId("quest-detail-modal")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(useStore.getState().questOverlayId).toBeNull();
  });

  it("closes on backdrop click", () => {
    const quest = makeVerificationQuest();
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });

    render(<QuestDetailModal />);

    fireEvent.click(screen.getByTestId("quest-detail-backdrop"));
    expect(useStore.getState().questOverlayId).toBeNull();
  });

  it("closes on close button click", () => {
    const quest = makeVerificationQuest();
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });

    render(<QuestDetailModal />);

    fireEvent.click(screen.getByTestId("quest-detail-close"));
    expect(useStore.getState().questOverlayId).toBeNull();
  });

  it("navigates to Questmaster and closes overlay on 'Open in Questmaster' click", () => {
    const quest = makeVerificationQuest();
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });

    render(<QuestDetailModal />);

    fireEvent.click(screen.getByTestId("quest-detail-open-questmaster"));

    // Should close the overlay
    expect(useStore.getState().questOverlayId).toBeNull();
    // Should navigate to questmaster with quest param
    expect(mockNavigateTo).toHaveBeenCalledWith("/questmaster?quest=q-42");
  });

  it("shows description rendered as markdown", () => {
    const quest = makeVerificationQuest();
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });

    render(<QuestDetailModal />);

    // Description contains "The sidebar overflows" text
    expect(screen.getByText(/The sidebar overflows/)).toBeTruthy();
  });

  it("shows verification items as read-only checkboxes", () => {
    const quest = makeVerificationQuest();
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });

    render(<QuestDetailModal />);

    // Verification item texts
    expect(screen.getByText("Sidebar no overflow on iPhone SE")).toBeTruthy();
    expect(screen.getByText("Scroll works")).toBeTruthy();

    // Checkboxes are read-only
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes[0]).toHaveProperty("checked", true);
    expect(checkboxes[1]).toHaveProperty("checked", false);
  });

  it("shows feedback entries with author labels", () => {
    const quest = makeVerificationQuest();
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });

    render(<QuestDetailModal />);

    expect(screen.getByText("Feedback")).toBeTruthy();
    expect(screen.getByText("Check iPad mini too")).toBeTruthy();
    expect(screen.getByText("Confirmed working on iPad mini.")).toBeTruthy();
    // Addressed badge on first feedback
    expect(screen.getByText("addressed")).toBeTruthy();
  });

  it("shows notes section for done quests", () => {
    const quest = makeDoneQuest();
    useStore.setState({ quests: [quest], questOverlayId: "q-99" });

    render(<QuestDetailModal />);

    expect(screen.getByText("Notes")).toBeTruthy();
    expect(screen.getByText(/Reduced p99 latency/)).toBeTruthy();
  });

  it("shows verification progress in the header", () => {
    const quest = makeVerificationQuest();
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });

    render(<QuestDetailModal />);

    // "1/2" progress (1 checked out of 2)
    expect(screen.getByText("1/2")).toBeTruthy();
  });

  it("shows images with clickable thumbnails", () => {
    const quest = makeVerificationQuest({
      images: [
        { id: "img-1", filename: "screenshot.png", mimeType: "image/png", path: "/path/to/img-1.png" },
      ],
    });
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });

    render(<QuestDetailModal />);

    // Image should be rendered
    const img = screen.getByAltText("screenshot.png");
    expect(img).toBeTruthy();
    expect(img.getAttribute("src")).toBe("/api/quests/_images/img-1");
  });

  it("locks body scroll when open", () => {
    const quest = makeVerificationQuest();
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });

    render(<QuestDetailModal />);

    expect(document.body.style.overflow).toBe("hidden");
  });

  it("closes lightbox first on Escape, keeping the quest modal open", () => {
    // When an image lightbox is open inside the modal, pressing Escape should
    // close the lightbox but keep the quest detail modal visible.
    const quest = makeVerificationQuest({
      images: [
        { id: "img-1", filename: "screenshot.png", mimeType: "image/png", path: "/path/to/img-1.png" },
      ],
    });
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });

    render(<QuestDetailModal />);

    // Click image to open lightbox
    const img = screen.getByAltText("screenshot.png");
    fireEvent.click(img);
    expect(screen.getByTestId("lightbox-backdrop")).toBeTruthy();

    // First Escape closes lightbox, not modal
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("lightbox-backdrop")).toBeNull();
    expect(useStore.getState().questOverlayId).toBe("q-42");

    // Second Escape closes modal
    fireEvent.keyDown(document, { key: "Escape" });
    expect(useStore.getState().questOverlayId).toBeNull();
  });

  it("renders a cancelled quest with red dot styling", () => {
    const quest = makeDoneQuest();
    // Manually add cancelled flag (done quests can be cancelled)
    (quest as Record<string, unknown>).cancelled = true;
    useStore.setState({ quests: [quest], questOverlayId: "q-99" });

    render(<QuestDetailModal />);

    // Should show the quest title
    expect(screen.getByText("Optimize DB queries")).toBeTruthy();
    // The modal should render (basic smoke test for cancelled path)
    expect(screen.getByTestId("quest-detail-modal")).toBeTruthy();
  });

  it("renders parent ID badge when quest has a parent", () => {
    const quest = makeVerificationQuest({ parentId: "q-10" });
    useStore.setState({ quests: [quest], questOverlayId: "q-42" });

    render(<QuestDetailModal />);

    expect(screen.getByText("sub:q-10")).toBeTruthy();
  });

  it("renders a minimal quest without optional fields", () => {
    // Idea-stage quest with no description, no verification, no feedback
    const quest: QuestmasterTask = {
      id: "q-5-v1",
      questId: "q-5",
      version: 1,
      title: "Bare idea quest",
      status: "idea",
      createdAt: Date.now() - 60000,
    } as QuestmasterTask;
    useStore.setState({ quests: [quest], questOverlayId: "q-5" });

    render(<QuestDetailModal />);

    expect(screen.getByText("Bare idea quest")).toBeTruthy();
    expect(screen.getByText("Idea")).toBeTruthy();
    // No verification, feedback, or notes sections
    expect(screen.queryByText("Verification")).toBeNull();
    expect(screen.queryByText("Feedback")).toBeNull();
    expect(screen.queryByText("Notes")).toBeNull();
  });
});
