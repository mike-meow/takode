import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUEST_JOURNEY_STATES } from "../../shared/quest-journey.js";
import type { BoardRow } from "../session-types.js";
import {
  advanceBoardRow,
  getBoard,
  getCompletedBoard,
  upsertBoardRow,
  type WorkBoardStateDeps,
} from "./board-watchdog-controller.js";

interface TestSession {
  id: string;
  board: Map<string, BoardRow>;
  completedBoard: Map<string, BoardRow>;
  boardDispatchStates: Map<string, unknown>;
}

function createSession(): TestSession {
  return {
    id: "leader-1",
    board: new Map(),
    completedBoard: new Map(),
    boardDispatchStates: new Map(),
  };
}

function createDeps(): WorkBoardStateDeps {
  return {
    getBoardDispatchableSignature: () => null,
    markNotificationDone: () => true,
    broadcastBoard: vi.fn(),
    persistSession: vi.fn(),
    notifyReview: vi.fn(),
  };
}

describe("Quest Journey board phase timing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts the active phase on upsert, closes it on advance, and persists timing on completion", () => {
    // Phase timing is stored on the board row Journey so normal session persistence
    // keeps it across server restarts without a separate migration path.
    const session = createSession();
    const deps = createDeps();

    vi.setSystemTime(new Date(1_000));
    upsertBoardRow(
      session,
      {
        questId: "q-1016",
        status: "PLANNING",
        journey: { phaseIds: ["alignment", "implement"] },
      },
      deps,
    );

    expect(getBoard(session)[0]?.journey?.phaseTimings).toEqual({
      "0": { startedAt: 1_000 },
    });

    vi.setSystemTime(new Date(61_000));
    const advanced = advanceBoardRow(session, "q-1016", QUEST_JOURNEY_STATES, deps);

    expect(advanced).toEqual(
      expect.objectContaining({ removed: false, previousState: "PLANNING", newState: "IMPLEMENTING" }),
    );
    expect(getBoard(session)[0]?.journey?.phaseTimings).toEqual({
      "0": { startedAt: 1_000, endedAt: 61_000 },
      "1": { startedAt: 61_000 },
    });

    vi.setSystemTime(new Date(181_000));
    const completed = advanceBoardRow(session, "q-1016", QUEST_JOURNEY_STATES, deps);

    expect(completed).toEqual(expect.objectContaining({ removed: true, previousState: "IMPLEMENTING" }));
    expect(getCompletedBoard(session)[0]?.completedAt).toBe(181_000);
    expect(getCompletedBoard(session)[0]?.journey?.phaseTimings).toEqual({
      "0": { startedAt: 1_000, endedAt: 61_000 },
      "1": { startedAt: 61_000, endedAt: 181_000 },
    });
  });

  it("tracks repeated phases by phase position instead of phase id", () => {
    // Repeated Journey phases are separate occurrences; keying by position avoids
    // collapsing two Implement phases into one timing bucket.
    const session = createSession();
    const deps = createDeps();

    vi.setSystemTime(new Date(1_000));
    upsertBoardRow(
      session,
      {
        questId: "q-1017",
        status: "IMPLEMENTING",
        journey: {
          phaseIds: ["implement", "code-review", "implement"],
          activePhaseIndex: 0,
        },
      },
      deps,
    );

    vi.setSystemTime(new Date(11_000));
    advanceBoardRow(session, "q-1017", QUEST_JOURNEY_STATES, deps);
    vi.setSystemTime(new Date(21_000));
    advanceBoardRow(session, "q-1017", QUEST_JOURNEY_STATES, deps);

    expect(getBoard(session)[0]?.journey?.phaseTimings).toEqual({
      "0": { startedAt: 1_000, endedAt: 11_000 },
      "1": { startedAt: 11_000, endedAt: 21_000 },
      "2": { startedAt: 21_000 },
    });
  });
});
