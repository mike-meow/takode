import type { LegacyQuestStatus, QuestDone, QuestFeedbackEntry, QuestmasterTask, QuestVerificationItem } from "./quest-types.js";
import { hasQuestReviewMetadata } from "./quest-types.js";

/** Normalize verification items: accept strings or {text,checked} objects.
 *  Rejects items with empty text. */
export function normalizeVerificationItems(items: unknown[]): QuestVerificationItem[] {
  const result: QuestVerificationItem[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      const text = item.trim();
      if (!text) throw new Error("Verification item text must not be empty");
      result.push({ text, checked: false });
    } else if (
      typeof item === "object" &&
      item !== null &&
      "text" in item &&
      typeof (item as { text: unknown }).text === "string"
    ) {
      const text = (item as { text: string }).text.trim();
      if (!text) throw new Error("Verification item text must not be empty");
      result.push({
        text,
        checked: !!(item as { checked?: boolean }).checked,
      });
    } else {
      throw new Error("Each verification item must be a string or { text: string, checked?: boolean }");
    }
  }
  return result;
}

/** Normalize stored commit SHAs. */
export function normalizeCommitShas(items: unknown[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item !== "string") {
      throw new Error("Each commit SHA must be a string");
    }
    const sha = item.trim().toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(sha)) {
      throw new Error(`Invalid commit SHA: ${item}`);
    }
    if (seen.has(sha)) continue;
    seen.add(sha);
    result.push(sha);
  }
  return result;
}

export function getActiveSessionId(quest: QuestmasterTask): string | undefined {
  if (!("sessionId" in quest) || typeof quest.sessionId !== "string") return undefined;
  const sid = quest.sessionId.trim();
  return sid.length > 0 ? sid : undefined;
}

export function getPreviousOwnerSessionIds(quest: QuestmasterTask): string[] {
  const raw = (quest as { previousOwnerSessionIds?: unknown }).previousOwnerSessionIds;
  if (!Array.isArray(raw)) return [];
  const unique = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const sid = v.trim();
    if (!sid) continue;
    unique.add(sid);
  }
  return [...unique];
}

type LegacyQuestRecord = Omit<QuestmasterTask, "status"> & {
  status: LegacyQuestStatus;
  completedAt?: number;
  verificationItems?: QuestVerificationItem[];
  verificationInboxUnread?: boolean;
  sessionId?: string;
  claimedAt?: number;
};

function normalizeLegacyNeedsVerificationQuest(quest: LegacyQuestRecord): QuestmasterTask {
  if (quest.status !== "needs_verification") return quest as QuestmasterTask;

  const previousOwners = getPreviousOwnerSessionIds(quest as QuestmasterTask);
  const active = getActiveSessionId(quest as QuestmasterTask);
  if (active && !previousOwners.includes(active)) previousOwners.push(active);

  const updatedAt = (quest as { updatedAt?: number }).updatedAt;
  const completedAt =
    typeof quest.completedAt === "number" && quest.completedAt > 0
      ? quest.completedAt
      : (quest.statusChangedAt ?? updatedAt ?? quest.createdAt);

  const normalized: QuestDone = {
    ...(quest as Omit<LegacyQuestRecord, "status">),
    status: "done",
    description: typeof quest.description === "string" ? quest.description : "",
    completedAt,
    verificationItems: Array.isArray(quest.verificationItems) ? quest.verificationItems : [],
    verificationInboxUnread: typeof quest.verificationInboxUnread === "boolean" ? quest.verificationInboxUnread : false,
    ...(previousOwners.length ? { previousOwnerSessionIds: previousOwners } : {}),
  };
  return normalized;
}

export function normalizeQuestOwnership(quest: QuestmasterTask): QuestmasterTask {
  const normalized = { ...normalizeLegacyNeedsVerificationQuest(quest as LegacyQuestRecord) } as QuestmasterTask & {
    previousOwnerSessionIds?: string[];
    sessionId?: string;
  };
  const previous = getPreviousOwnerSessionIds(normalized);
  const active = getActiveSessionId(normalized);

  // Legacy normalization: done quests used to carry sessionId. Treat it as past owner.
  if (normalized.status === "done" && active) {
    if (!previous.includes(active)) previous.push(active);
    delete normalized.sessionId;
  }

  const finalActive = getActiveSessionId(normalized);
  if (finalActive) {
    const idx = previous.indexOf(finalActive);
    if (idx !== -1) previous.splice(idx, 1);
  }

  if (previous.length > 0) {
    normalized.previousOwnerSessionIds = previous;
  } else {
    delete normalized.previousOwnerSessionIds;
  }
  return normalized;
}

export function shouldMarkVerificationInboxUnreadFromFeedbackPatch(
  current: QuestmasterTask,
  nextFeedback: QuestFeedbackEntry[] | undefined,
): boolean {
  if (!hasQuestReviewMetadata(current)) return false;
  const previous = current.feedback ?? [];
  if (previous.length === 0 && (!nextFeedback || nextFeedback.length === 0)) return false;

  const maxLength = Math.max(previous.length, nextFeedback?.length ?? 0);
  for (let index = 0; index < maxLength; index += 1) {
    const before = previous[index];
    const after = nextFeedback?.[index];
    if (feedbackEntriesEqual(before, after)) continue;
    if (before?.author === "agent" || after?.author === "agent") return true;
  }
  return false;
}

function feedbackEntriesEqual(a: QuestFeedbackEntry | undefined, b: QuestFeedbackEntry | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.author === b.author &&
    a.text === b.text &&
    a.tldr === b.tldr &&
    a.ts === b.ts &&
    a.authorSessionId === b.authorSessionId &&
    a.addressed === b.addressed &&
    questImagesEqual(a.images, b.images)
  );
}

function questImagesEqual(
  a: QuestFeedbackEntry["images"] | undefined,
  b: QuestFeedbackEntry["images"] | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every(
    (image, index) =>
      image.id === b[index]?.id &&
      image.filename === b[index]?.filename &&
      image.mimeType === b[index]?.mimeType &&
      image.path === b[index]?.path,
  );
}
