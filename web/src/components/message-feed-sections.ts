import {
  HISTORY_WINDOW_SECTION_TURN_COUNT,
  HISTORY_WINDOW_VISIBLE_SECTION_COUNT,
} from "../../shared/history-window.js";
import type { Turn } from "../hooks/use-feed-model.js";

export const DEFAULT_VISIBLE_SECTION_COUNT = HISTORY_WINDOW_VISIBLE_SECTION_COUNT;
export const FEED_SECTION_TURN_COUNT = HISTORY_WINDOW_SECTION_TURN_COUNT;

export interface TurnOffsetIndex {
  turnId: string | null;
  offsetTop: number;
}

export interface FeedSection {
  id: string;
  turns: Turn[];
}

export function buildFeedSections(turns: Turn[], sectionTurnCount = FEED_SECTION_TURN_COUNT): FeedSection[] {
  if (turns.length === 0) return [];

  const sections: FeedSection[] = [];
  const normalizedSectionTurnCount = Math.max(1, sectionTurnCount);
  for (let start = 0; start < turns.length; start += normalizedSectionTurnCount) {
    const current = turns.slice(start, start + normalizedSectionTurnCount);
    if (current.length === 0) continue;
    sections.push({
      id: current[0]?.id ?? `section-${sections.length}`,
      turns: current,
    });
  }

  return sections;
}

export function findVisibleSectionStartIndex(sections: FeedSection[], visibleSectionCount: number): number {
  return Math.max(0, sections.length - Math.max(1, visibleSectionCount));
}

export function findVisibleSectionEndIndex(
  sections: FeedSection[],
  startIndex: number,
  visibleSectionCount: number,
): number {
  if (sections.length === 0) return 0;
  const normalizedStartIndex = Math.min(Math.max(0, startIndex), sections.length - 1);
  return Math.min(sections.length, normalizedStartIndex + Math.max(1, visibleSectionCount));
}

export function findSectionWindowStartIndexForTarget(
  sections: FeedSection[],
  targetIndex: number,
  visibleSectionCount: number,
): number {
  if (sections.length === 0) return 0;
  const normalizedCount = Math.max(1, visibleSectionCount);
  const maxStartIndex = Math.max(0, sections.length - normalizedCount);
  return Math.min(Math.max(0, targetIndex - 1), maxStartIndex);
}

export function findActiveTaskTurnIdForScroll(
  turnOffsets: TurnOffsetIndex[],
  scrollTop: number,
  fallbackTurnId: string | null,
  offsetPx = 48,
): string | null {
  if (turnOffsets.length === 0) return fallbackTurnId;

  const targetOffset = scrollTop + offsetPx;
  let low = 0;
  let high = turnOffsets.length - 1;
  let best = -1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (turnOffsets[mid].offsetTop <= targetOffset) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best >= 0 ? turnOffsets[best]?.turnId ?? fallbackTurnId : fallbackTurnId;
}
