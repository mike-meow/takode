// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { QuestJourneyPhaseId, QuestJourneyPlanState } from "../../shared/quest-journey.js";
import { QuestJourneyPreviewCard, QuestJourneyTimeline } from "./QuestJourneyTimeline.js";

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

function longJourney(overrides: Partial<QuestJourneyPlanState> = {}): QuestJourneyPlanState {
  const phaseIds = Array.from({ length: 38 }, (_, index) => PHASE_CYCLE[index % PHASE_CYCLE.length]);
  return {
    mode: "active",
    phaseIds,
    currentPhaseId: phaseIds[20],
    activePhaseIndex: 20,
    ...overrides,
  };
}

function visiblePhaseIndexes(container: HTMLElement): number[] {
  return Array.from(container.querySelectorAll("li[data-phase-index]")).map((row) =>
    Number(row.getAttribute("data-phase-index")),
  );
}

describe("QuestJourneyTimeline vertical clamping", () => {
  it("clamps long active vertical Journeys around the current phase and expands omitted blocks inline", () => {
    const journey = longJourney({
      phaseNotes: {
        "14": "Hidden earlier boundary note",
        "15": "Visible earlier boundary note",
        "30": "Visible later boundary note",
        "31": "Hidden later boundary note",
      },
      phaseTimings: {
        "15": { startedAt: 1_000, endedAt: 61_000 },
      },
    });

    render(<QuestJourneyTimeline journey={journey} status="USER_CHECKPOINTING" variant="vertical" />);

    const timeline = screen.getByTestId("quest-journey-timeline");
    expect(visiblePhaseIndexes(timeline)).toEqual(Array.from({ length: 16 }, (_, index) => index + 15));
    expect(timeline.querySelector('li[data-phase-index="20"]')).toHaveAttribute("data-phase-current", "true");
    expect(timeline).toHaveTextContent("38 phases · Partial 1m");
    expect(within(timeline).getByTestId("quest-journey-phase-duration")).toHaveTextContent("1m");
    expect(within(timeline).queryByText("duration unavailable")).toBeNull();
    expect(within(timeline).getByRole("button", { name: "Show 15 earlier phases" })).toBeInTheDocument();
    expect(within(timeline).getByRole("button", { name: "Show 7 later phases" })).toBeInTheDocument();
    expect(within(timeline).queryByText("Hidden earlier boundary note")).toBeNull();
    expect(within(timeline).getByText("Visible earlier boundary note")).toBeInTheDocument();
    expect(within(timeline).getByText("Visible later boundary note")).toBeInTheDocument();
    expect(within(timeline).queryByText("Hidden later boundary note")).toBeNull();

    fireEvent.click(within(timeline).getByRole("button", { name: "Show 15 earlier phases" }));
    expect(visiblePhaseIndexes(timeline).slice(0, 16)).toEqual(Array.from({ length: 16 }, (_, index) => index));
    expect(within(timeline).getByRole("button", { name: "Hide 15 earlier phases" })).toBeInTheDocument();
    expect(within(timeline).getByText("Hidden earlier boundary note")).toBeInTheDocument();

    fireEvent.click(within(timeline).getByRole("button", { name: "Show 7 later phases" }));
    expect(visiblePhaseIndexes(timeline).slice(-7)).toEqual([31, 32, 33, 34, 35, 36, 37]);
    expect(within(timeline).getByRole("button", { name: "Hide 7 later phases" })).toBeInTheDocument();
    expect(within(timeline).getByText("Hidden later boundary note")).toBeInTheDocument();
  });

  it("keeps start-adjacent current phases anchored at the beginning without an earlier omitted block", () => {
    const phaseIds = longJourney().phaseIds;
    render(
      <QuestJourneyTimeline
        journey={{ mode: "active", phaseIds, currentPhaseId: phaseIds[2], activePhaseIndex: 2 }}
        status="IMPLEMENTING"
        variant="vertical"
      />,
    );

    const timeline = screen.getByTestId("quest-journey-timeline");
    expect(visiblePhaseIndexes(timeline)).toEqual(Array.from({ length: 13 }, (_, index) => index));
    expect(within(timeline).queryByRole("button", { name: /earlier phases/ })).toBeNull();
    expect(within(timeline).getByRole("button", { name: "Show 25 later phases" })).toBeInTheDocument();
  });

  it("anchors completed and no-current vertical Journeys near the final phase", () => {
    const phaseIds = longJourney().phaseIds;

    render(<QuestJourneyTimeline journey={{ mode: "active", phaseIds }} status="done" variant="vertical" />);

    const timeline = screen.getByTestId("quest-journey-timeline");
    expect(timeline).toHaveAttribute("data-journey-mode", "completed");
    expect(visiblePhaseIndexes(timeline)).toEqual([32, 33, 34, 35, 36, 37]);
    expect(within(timeline).getByRole("button", { name: "Show 32 earlier phases" })).toBeInTheDocument();
    expect(within(timeline).queryByRole("button", { name: /later phases/ })).toBeNull();
  });

  it("does not clamp short vertical Journeys", () => {
    render(
      <QuestJourneyPreviewCard
        journey={{
          mode: "active",
          phaseIds: ["alignment", "implement", "code-review", "port"],
          currentPhaseId: "implement",
        }}
        status="IMPLEMENTING"
      />,
    );

    const preview = screen.getByTestId("quest-journey-preview-card");
    expect(visiblePhaseIndexes(preview)).toEqual([0, 1, 2, 3]);
    expect(within(preview).queryByTestId("quest-journey-omitted-phases")).toBeNull();
  });
});
