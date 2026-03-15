import { useMemo } from "react";
import { useStore } from "../store.js";
import type { Turn } from "./use-feed-model.js";

export interface TurnCollapseState {
  turnId: string;
  defaultExpanded: boolean;
  isActivityExpanded: boolean;
}

function shouldForceLeaderLatestTurnExpanded(
  turn: Turn,
  isLastTurn: boolean,
  leaderMode: boolean,
  sessionStatus: "idle" | "running" | "compacting" | "reverting" | null,
): boolean {
  if (!leaderMode || sessionStatus !== "running" || !isLastTurn) return false;
  return turn.allEntries.length > 0;
}

export function useCollapsePolicy({
  sessionId,
  turns,
  leaderMode,
}: {
  sessionId: string;
  turns: Turn[];
  leaderMode: boolean;
}): {
  turnStates: TurnCollapseState[];
  toggleTurn: (turnId: string) => void;
} {
  const overrides = useStore((s) => s.turnActivityOverrides.get(sessionId));
  const toggleTurnActivity = useStore((s) => s.toggleTurnActivity);
  const sessionStatus = useStore((s) => s.sessionStatus.get(sessionId) ?? null);

  const turnStates = useMemo(() => {
    return turns.map((turn, index) => {
      const isLastTurn = index === turns.length - 1;
      const defaultExpanded = isLastTurn;
      const override = overrides?.get(turn.id);
      const isActivityExpanded = shouldForceLeaderLatestTurnExpanded(turn, isLastTurn, leaderMode, sessionStatus)
        ? true
        : override !== undefined
          ? override
          : defaultExpanded;

      return {
        turnId: turn.id,
        defaultExpanded,
        isActivityExpanded,
      };
    });
  }, [leaderMode, overrides, sessionStatus, turns]);

  const turnStateById = useMemo(() => new Map(turnStates.map((state) => [state.turnId, state])), [turnStates]);

  const toggleTurn = (turnId: string) => {
    const state = turnStateById.get(turnId);
    if (!state) return;
    toggleTurnActivity(sessionId, turnId, state.defaultExpanded);
  };

  return {
    turnStates,
    toggleTurn,
  };
}
