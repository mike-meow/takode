import { useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { writeClipboardText } from "./copy-utils.js";
import type { QuestmasterTask, QuestVerificationItem } from "../types.js";

/** Prefix a session name with ☐/☑ based on quest status, or return it unmodified for non-quest sessions. */
export function questLabel(
  name: string,
  isQuestNamed: boolean,
  questStatus: string | undefined,
  verificationInboxUnread?: boolean | null,
): string {
  if (!isQuestNamed) return name;
  return questStatus === "needs_verification" || (questStatus === "done" && verificationInboxUnread !== undefined)
    ? `☑ ${name}`
    : `☐ ${name}`;
}

/** Quest-owned session titles stay sticky through review handoff until the claim is cleared. */
export function questOwnsSessionName(
  questStatus: string | undefined,
  verificationInboxUnread?: boolean | null,
): boolean {
  return (
    questStatus === "in_progress" ||
    questStatus === "needs_verification" ||
    (questStatus === "done" && verificationInboxUnread !== undefined)
  );
}

/** Relative time display (e.g. "5m ago", "2h ago", "3d ago"). */
export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Count checked vs total verification items. */
export function verificationProgress(items: QuestVerificationItem[]): { checked: number; total: number } {
  return { checked: items.filter((i) => i.checked).length, total: items.length };
}

/**
 * Get the active (or most recent previous) owner session ID for a quest.
 * Falls back to previousOwnerSessionIds if the active sessionId is empty.
 */
export function getQuestOwnerSessionId(quest: QuestmasterTask): string | null {
  if ("sessionId" in quest && typeof quest.sessionId === "string") {
    const active = quest.sessionId.trim();
    if (active) return active;
  }
  const previous = (quest as { previousOwnerSessionIds?: unknown }).previousOwnerSessionIds;
  if (!Array.isArray(previous) || previous.length === 0) return null;
  for (let i = previous.length - 1; i >= 0; i--) {
    const sid = previous[i];
    if (typeof sid !== "string") continue;
    const trimmed = sid.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/** Get the quest's orchestrating leader session ID, when it was recorded. */
export function getQuestLeaderSessionId(quest: QuestmasterTask): string | null {
  const raw = (quest as { leaderSessionId?: unknown }).leaderSessionId;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

/** Click-to-copy quest ID with brief visual confirmation. */
export function CopyableQuestId({
  questId,
  className,
  children,
  onClick,
}: {
  questId: string;
  className?: string;
  children?: ReactNode;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const [copied, setCopied] = useState(false);

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.stopPropagation();
    }
  }

  return (
    <button
      type="button"
      className={`cursor-pointer hover:text-cc-fg transition-colors ${className || "text-[10px] text-cc-muted/60"}`}
      title="Click to copy quest ID"
      onKeyDown={handleKeyDown}
      onClick={(e) => {
        onClick?.(e);
        e.stopPropagation();
        writeClipboardText(questId)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          })
          .catch(console.error);
      }}
    >
      {copied ? "Copied!" : (children ?? questId)}
    </button>
  );
}
