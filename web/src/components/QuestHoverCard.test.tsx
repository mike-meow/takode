// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useStore } from "../store.js";
import type { QuestJourneyPhaseId } from "../../shared/quest-journey.js";
import type { QuestmasterTask } from "../types.js";
import { QuestHoverCard } from "./QuestHoverCard.js";

const PHASE_CYCLE: QuestJourneyPhaseId[] = [
  "alignment",
  "explore",
  "implement",
  "code-review",
  "user-checkpoint",
  "port",
  "execute",
  "outcome-review",
];

function anchorRect(): DOMRect {
  return {
    x: 12,
    y: 20,
    left: 12,
    top: 20,
    right: 112,
    bottom: 44,
    width: 100,
    height: 24,
    toJSON: () => ({}),
  } as DOMRect;
}

describe("QuestHoverCard", () => {
  beforeEach(() => {
    useStore.getState().reset();
    window.history.replaceState({}, "", "/#/session/s1");
  });

  it("shows completed time and description TLDR before the Journey preview", () => {
    const completedAt = Date.now() - 2 * 60 * 60 * 1000;
    const quest: QuestmasterTask = {
      id: "q-77-v1",
      questId: "q-77",
      version: 1,
      title: "Finish hover Journey",
      status: "done",
      description: "Completed quest with retained Journey metadata.",
      tldr: "Compact hover cards should show the **outcome** before Journey details.\n\n- Keep it scannable.",
      createdAt: completedAt - 60_000,
      completedAt,
      verificationItems: [],
    };
    useStore.setState((state) => ({
      ...state,
      sessionCompletedBoards: new Map([
        [
          "leader-abc",
          [
            {
              questId: "q-77",
              title: "Finish hover Journey",
              status: "PORTING",
              updatedAt: completedAt,
              completedAt,
              journey: {
                mode: "active",
                phaseIds: ["alignment", "implement", "code-review", "port"],
                currentPhaseId: "port",
              },
            },
          ],
        ],
      ]),
    }));

    render(<QuestHoverCard quest={quest} anchorRect={anchorRect()} onMouseEnter={() => {}} onMouseLeave={() => {}} />);

    const card = screen.getByTestId("quest-hover-card");
    const tldr = within(card).getByTestId("quest-hover-tldr");
    const journey = within(card).getByTestId("quest-hover-journey");

    expect(within(card).getByTestId("quest-hover-completed-at").textContent).toBe("Finished 2h ago");
    expect(tldr.textContent).toContain("Summary");
    expect(tldr.textContent).toContain("Compact hover cards should show the outcome before Journey details.");
    expect(within(tldr).getByText("outcome").tagName).toBe("STRONG");
    expect(within(tldr).getByText("Keep it scannable.").tagName).toBe("LI");
    expect(tldr.compareDocumentPosition(journey) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(journey).getByText("Completed Journey")).toBeTruthy();
  });

  it("clamps long Journey previews around the current phase with inline expansion", () => {
    const phaseIds = Array.from({ length: 38 }, (_, index) => PHASE_CYCLE[index % PHASE_CYCLE.length]);
    const quest: QuestmasterTask = {
      id: "q-1095-v1",
      questId: "q-1095",
      version: 1,
      title: "Collapse long Journey previews",
      status: "in_progress",
      description: "Long Journey previews should not dominate the hover panel.",
      createdAt: 1,
      sessionId: "worker-long",
      claimedAt: 1,
    };
    useStore.setState((state) => ({
      ...state,
      sessionBoards: new Map([
        [
          "leader-long",
          [
            {
              questId: "q-1095",
              title: "Collapse long Journey previews",
              status: "USER_CHECKPOINTING",
              updatedAt: 2,
              journey: {
                mode: "active",
                phaseIds,
                currentPhaseId: phaseIds[20],
                activePhaseIndex: 20,
                phaseNotes: {
                  "14": "Hidden hover note",
                  "15": "Visible hover boundary note",
                  "30": "Visible later hover boundary note",
                },
              },
            },
          ],
        ],
      ]),
    }));

    render(<QuestHoverCard quest={quest} anchorRect={anchorRect()} onMouseEnter={() => {}} onMouseLeave={() => {}} />);

    const journey = within(screen.getByTestId("quest-hover-card")).getByTestId("quest-hover-journey");
    const visibleIndexes = Array.from(journey.querySelectorAll("li[data-phase-index]")).map((row) =>
      Number(row.getAttribute("data-phase-index")),
    );
    expect(visibleIndexes).toEqual(Array.from({ length: 16 }, (_, index) => index + 15));
    expect(within(journey).getByRole("button", { name: "Show 15 earlier phases" })).toBeTruthy();
    expect(within(journey).getByRole("button", { name: "Show 7 later phases" })).toBeTruthy();
    expect(within(journey).getByText("Visible hover boundary note")).toBeTruthy();
    expect(within(journey).getByText("Visible later hover boundary note")).toBeTruthy();
    expect(within(journey).queryByText("Hidden hover note")).toBeNull();
  });

  it("uses whole-chip session links for worker, reviewer, and leader participants", async () => {
    const quest: QuestmasterTask = {
      id: "q-42-v1",
      questId: "q-42",
      version: 1,
      title: "Fix auth race condition",
      status: "in_progress",
      description: "Ensure claim state updates atomically.",
      createdAt: 1,
      sessionId: "worker-abc",
      leaderSessionId: "leader-abc",
      claimedAt: 1,
    };
    useStore.setState((state) => ({
      ...state,
      sdkSessions: [
        { sessionId: "worker-abc", state: "running", cwd: "/repo", createdAt: 1, sessionNum: 123 },
        { sessionId: "reviewer-abc", state: "connected", cwd: "/repo", createdAt: 1, sessionNum: 8 },
        { sessionId: "leader-abc", state: "connected", cwd: "/repo", createdAt: 1, sessionNum: 7 },
      ],
      sessionBoards: new Map([
        [
          "leader-abc",
          [
            {
              questId: "q-42",
              status: "IMPLEMENTING",
              updatedAt: 2,
              journey: { mode: "active", phaseIds: ["alignment", "implement"], currentPhaseId: "implement" },
            },
          ],
        ],
      ]),
      sessionBoardRowStatuses: new Map([
        [
          "leader-abc",
          {
            "q-42": {
              worker: { sessionId: "worker-abc", sessionNum: 123, name: "Auth Worker", status: "running" },
              reviewer: { sessionId: "reviewer-abc", sessionNum: 8, name: "Quest Reviewer", status: "idle" },
            },
          },
        ],
      ]),
      sessionNames: new Map([
        ["worker-abc", "Auth Worker"],
        ["reviewer-abc", "Quest Reviewer"],
        ["leader-abc", "Quest Leader"],
      ]),
    }));

    render(<QuestHoverCard quest={quest} anchorRect={anchorRect()} onMouseEnter={() => {}} onMouseLeave={() => {}} />);

    const card = screen.getByTestId("quest-hover-card");
    const participants = within(card).getByTestId("quest-hover-participants");
    const worker = within(card).getByRole("link", { name: "Worker #123 Auth Worker" });
    const reviewer = within(card).getByRole("link", { name: "Reviewer #8 Quest Reviewer" });
    const leader = within(card).getByRole("link", { name: "Leader #7 Quest Leader" });

    expect(card.style.width).toBe("560px");
    expect(participants.contains(worker)).toBe(true);
    expect(participants.contains(reviewer)).toBe(true);
    expect(participants.contains(leader)).toBe(true);
    expect(within(card).queryByText("Leader session")).toBeNull();
    expect(worker.getAttribute("href")).toBe("#/session/123");
    expect(worker.textContent).toContain("Worker");
    expect(worker.textContent).toContain("#123");
    expect(worker.textContent).toContain("Auth Worker");
    expect(worker.textContent).not.toContain("running");
    expect(reviewer.textContent).not.toContain("idle");
    expect(worker.className).toContain("rounded-full");
    expect(worker.className).toContain("bg-cc-hover/25");
    expect(worker.className).not.toContain("bg-cc-primary");
    expect(reviewer.className).not.toContain("bg-violet");
    expect(leader.className).not.toContain("bg-amber-400");
    expect(reviewer.getAttribute("href")).toBe("#/session/8");
    expect(leader.getAttribute("href")).toBe("#/session/7");

    fireEvent.mouseEnter(worker);
    await waitFor(() => expect(screen.getAllByText("Auth Worker").length).toBeGreaterThan(1));
  });

  it("opens the existing quest detail overlay from the compact action", () => {
    const onMouseLeave = vi.fn();
    const quest: QuestmasterTask = {
      id: "q-42-v1",
      questId: "q-42",
      version: 1,
      title: "Fix auth race condition",
      status: "refined",
      description: "Ensure claim state updates atomically.",
      createdAt: 1,
    };

    render(
      <QuestHoverCard quest={quest} anchorRect={anchorRect()} onMouseEnter={() => {}} onMouseLeave={onMouseLeave} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open q-42 quest details" }));

    expect(useStore.getState().questOverlayId).toBe("q-42");
    expect(onMouseLeave).toHaveBeenCalledTimes(1);
  });
});
