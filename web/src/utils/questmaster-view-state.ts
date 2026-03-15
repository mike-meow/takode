import type { QuestStatus } from "../types.js";
import { scopedGetItem, scopedSetItem } from "./scoped-storage.js";

const QUESTMASTER_VIEW_STATE_KEY = "cc-questmaster-view";
export const VERIFICATION_INBOX_COLLAPSE_KEY = "verification_inbox";

export type QuestmasterCollapsedGroup = QuestStatus | typeof VERIFICATION_INBOX_COLLAPSE_KEY;

const QUESTMASTER_COLLAPSE_GROUPS: Set<QuestmasterCollapsedGroup> = new Set([
  "idea",
  "refined",
  "in_progress",
  "needs_verification",
  "done",
  VERIFICATION_INBOX_COLLAPSE_KEY,
]);

export type QuestmasterViewState = {
  scrollTop: number;
  collapsedGroups: QuestmasterCollapsedGroup[];
};

function normalizeCollapsedGroups(value: unknown): QuestmasterCollapsedGroup[] {
  if (!Array.isArray(value)) return [];
  return value.filter((status): status is QuestmasterCollapsedGroup =>
    QUESTMASTER_COLLAPSE_GROUPS.has(status as QuestmasterCollapsedGroup),
  );
}

export function loadQuestmasterViewState(): QuestmasterViewState | null {
  const raw = scopedGetItem(QUESTMASTER_VIEW_STATE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { scrollTop?: unknown; collapsedGroups?: unknown };
    const scrollTop =
      typeof parsed.scrollTop === "number" && Number.isFinite(parsed.scrollTop) ? Math.max(0, parsed.scrollTop) : 0;
    return {
      scrollTop,
      collapsedGroups: normalizeCollapsedGroups(parsed.collapsedGroups),
    };
  } catch {
    return null;
  }
}

export function saveQuestmasterViewState(state: QuestmasterViewState): void {
  scopedSetItem(
    QUESTMASTER_VIEW_STATE_KEY,
    JSON.stringify({
      scrollTop: Math.max(0, state.scrollTop),
      collapsedGroups: normalizeCollapsedGroups(state.collapsedGroups),
    }),
  );
}
