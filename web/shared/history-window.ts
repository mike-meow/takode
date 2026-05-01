export const HISTORY_WINDOW_SECTION_TURN_COUNT = 5;
export const HISTORY_WINDOW_VISIBLE_SECTION_COUNT = 3;

export function getHistoryWindowTurnCount(
  visibleSectionCount = HISTORY_WINDOW_VISIBLE_SECTION_COUNT,
  sectionTurnCount = HISTORY_WINDOW_SECTION_TURN_COUNT,
): number {
  return Math.max(1, Math.floor(visibleSectionCount)) * Math.max(1, Math.floor(sectionTurnCount));
}
