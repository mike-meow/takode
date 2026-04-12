import type React from "react";
import type { QuestmasterTask, QuestVerificationItem, QuestFeedbackEntry } from "../types.js";

// ─── Quest field accessors (type-safe access to optional quest properties) ──

export function isQuestCancelled(quest: QuestmasterTask): boolean {
  return "cancelled" in quest && !!(quest as { cancelled?: boolean }).cancelled;
}

export function getQuestDescription(quest: QuestmasterTask): string | undefined {
  return "description" in quest ? quest.description : undefined;
}

export function getQuestNotes(quest: QuestmasterTask): string | undefined {
  return "notes" in quest ? (quest as { notes?: string }).notes : undefined;
}

export function getQuestFeedback(quest: QuestmasterTask): QuestFeedbackEntry[] {
  return "feedback" in quest ? ((quest as { feedback?: QuestFeedbackEntry[] }).feedback ?? []) : [];
}

export function getQuestUpdatedAt(quest: QuestmasterTask): number {
  return (quest as { updatedAt?: number }).updatedAt ?? quest.createdAt;
}

// ─── Clipboard helpers ──────────────────────────────────────────────────────

/** Extract image files from a paste event's clipboard data. */
export function extractPastedImages(e: React.ClipboardEvent): File[] {
  const items = e.clipboardData?.items;
  if (!items) return [];
  const files: File[] = [];
  for (const item of Array.from(items)) {
    if (!item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

/** Extract #hashtag tokens from text. Returns lowercase tag names (without #). */
export function extractHashtags(text: string): string[] {
  const tags = new Set<string>();
  const matches = text.matchAll(/(^|\s)#([a-zA-Z0-9][a-zA-Z0-9_-]*)/g);
  for (const match of matches) tags.add(match[2].toLowerCase());
  return Array.from(tags);
}

/** Find the #hashtag token at the cursor position for autocomplete. */
export function findHashtagTokenAtCursor(
  text: string,
  cursor: number,
): { start: number; end: number; query: string } | null {
  const clamped = Math.max(0, Math.min(cursor, text.length));
  const beforeCursor = text.slice(0, clamped);
  const hashPos = beforeCursor.lastIndexOf("#");
  if (hashPos < 0) return null;
  if (hashPos > 0) {
    const prev = beforeCursor[hashPos - 1];
    if (!/\s/.test(prev)) return null;
  }
  const token = beforeCursor.slice(hashPos + 1);
  if (/\s/.test(token)) return null;
  return { start: hashPos, end: clamped, query: token };
}

/** Check whether a quest is an unread verification inbox item. */
export function isVerificationInboxUnread(quest: QuestmasterTask): boolean {
  return (
    quest.status === "needs_verification" && !!(quest as { verificationInboxUnread?: boolean }).verificationInboxUnread
  );
}

const DEFAULT_DONE_VERIFICATION_ITEM: QuestVerificationItem = {
  text: "User marked this quest as done in Questmaster.",
  checked: true,
};

/** Get default verification items to attach when marking a quest done (if it has none). */
export function getDoneVerificationItems(quest: QuestmasterTask): QuestVerificationItem[] | undefined {
  if ("verificationItems" in quest && Array.isArray(quest.verificationItems) && quest.verificationItems.length > 0) {
    return undefined;
  }
  return [DEFAULT_DONE_VERIFICATION_ITEM];
}

/** Auto-resize a textarea to fit its content, capped at maxHeight. */
export function autoResizeTextarea(ta: HTMLTextAreaElement | null, maxHeight = 200) {
  if (!ta) return;
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, maxHeight) + "px";
}
