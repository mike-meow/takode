import { useMemo } from "react";
import { useStore } from "../store.js";
import { isUserBoundaryEntry, type Turn } from "./use-feed-model.js";

export interface TurnCollapseState {
  turnId: string;
  defaultExpanded: boolean;
  isActivityExpanded: boolean;
  keepExpandedDuringStreaming: boolean;
}

function getDefaultTurnExpanded(
  turn: Turn,
  isLastTurn: boolean,
  keepExpandedDuringStreaming: boolean,
  leaderMode: boolean,
): boolean {
  // Leader mode: keep @to(user) turns expanded — their responseEntry is set
  // only when the turn contains a user-addressed message. Everything else
  // (internal activity, herd events, @to(self)) collapses as before.
  if (leaderMode) return isLastTurn || keepExpandedDuringStreaming || turn.responseEntry !== null;
  return isLastTurn || turn.responseEntry === null || keepExpandedDuringStreaming;
}

function shouldForceLeaderStreamingTurnExpanded(
  turn: Turn,
  isLastTurn: boolean,
  keepExpandedDuringStreaming: boolean,
  leaderMode: boolean,
  sessionStatus: "idle" | "running" | "compacting" | "reverting" | null,
): boolean {
  if (!leaderMode || sessionStatus !== "running") return false;
  if (turn.allEntries.length === 0) return false;
  return isLastTurn || keepExpandedDuringStreaming;
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
  sessionStatus: "idle" | "running" | "compacting" | "reverting" | null;
} {
  const overrides = useStore((s) => s.turnActivityOverrides.get(sessionId));
  const autoExpandedTurnIds = useStore((s) => s.autoExpandedTurnIds.get(sessionId));
  const toggleTurnActivity = useStore((s) => s.toggleTurnActivity);
  const sessionStatus = useStore((s) => s.sessionStatus.get(sessionId) ?? null);

  const turnStates = useMemo(() => {
    const lastTurn = turns[turns.length - 1];
    const lastTurnIsFreshUserOnly = isUserBoundaryEntry(lastTurn?.userEntry || null) && lastTurn.allEntries.length === 0;

    return turns.map((turn, index) => {
      const isLastTurn = index === turns.length - 1;
      const isPenultimateTurn = index === turns.length - 2;
      const keepExpandedDuringStreaming =
        sessionStatus === "running" && isPenultimateTurn && lastTurnIsFreshUserOnly;
      const override = overrides?.get(turn.id);
      const defaultExpanded = getDefaultTurnExpanded(turn, isLastTurn, keepExpandedDuringStreaming, leaderMode);
      const isAutoExpanded = autoExpandedTurnIds?.has(turn.id) === true && (isLastTurn || isPenultimateTurn);
      const isActivityExpanded = shouldForceLeaderStreamingTurnExpanded(
        turn,
        isLastTurn,
        keepExpandedDuringStreaming,
        leaderMode,
        sessionStatus,
      )
        ? true
        : (override !== undefined ? override : (isAutoExpanded ? true : defaultExpanded));

      return {
        turnId: turn.id,
        defaultExpanded,
        isActivityExpanded,
        keepExpandedDuringStreaming,
      };
    });
  }, [turns, overrides, autoExpandedTurnIds, sessionStatus, leaderMode]);

  const turnStateById = useMemo(() => new Map(turnStates.map((state) => [state.turnId, state])), [turnStates]);

  const toggleTurn = (turnId: string) => {
    const state = turnStateById.get(turnId);
    if (!state) return;
    toggleTurnActivity(sessionId, turnId, state.defaultExpanded);
  };

  return {
    turnStates,
    toggleTurn,
    sessionStatus,
  };
}
