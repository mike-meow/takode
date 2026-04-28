import type { QuestmasterTask } from "../server/quest-types.js";
import { hasQuestReviewMetadata, isQuestReviewInboxUnread } from "../server/quest-types.js";
import type { SessionMetadata } from "./quest-session-metadata.js";
import { normalizeTldr } from "../server/quest-tldr.js";
export type { SessionMetadata } from "./quest-session-metadata.js";

type FormatSessionOptions = {
  currentSessionId?: string;
  getSessionName?: (sessionId: string) => string | undefined;
  preferSessionNum?: boolean;
};

type FormatQuestOptions = Omit<FormatSessionOptions, "preferSessionNum">;

const STATUS_ICONS: Record<string, string> = {
  idea: "○",
  refined: "●",
  in_progress: "◐",
  done: "✓",
};

const STATUS_LABELS: Record<string, string> = {
  idea: "idea",
  refined: "refined",
  in_progress: "in_progress",
  done: "done",
};

function timeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function isVerificationInboxUnreadQuest(q: QuestmasterTask): boolean {
  return isQuestReviewInboxUnread(q);
}

function questRecencyTs(q: QuestmasterTask): number {
  return Math.max(q.createdAt, (q as { updatedAt?: number }).updatedAt ?? 0, q.statusChangedAt ?? 0);
}

export function formatSessionLabel(
  sid: string,
  sessionMetadata?: Map<string, SessionMetadata>,
  options?: FormatSessionOptions,
): string {
  const metadata = sessionMetadata?.get(sid);
  const name = metadata?.name || options?.getSessionName?.(sid);
  const isYou = options?.currentSessionId === sid;
  const notes = [metadata?.archived ? "archived" : "", isYou ? "you" : ""].filter(Boolean);
  const shortId = sid.slice(0, 8);

  if (options?.preferSessionNum && metadata?.sessionNum != null) {
    const head = `#${metadata.sessionNum}${name ? ` "${name}"` : ""}`;
    return `${head} (${[shortId, ...notes].join(", ")})`;
  }

  const suffix = notes.length ? ` (${notes.join(", ")})` : "";
  return name ? `"${name}" (${shortId})${suffix}` : `${shortId}${suffix}`;
}

export function formatQuestLine(
  q: QuestmasterTask,
  sessionMetadata?: Map<string, SessionMetadata>,
  options?: FormatQuestOptions,
): string {
  const cancelled = "cancelled" in q && (q as { cancelled?: boolean }).cancelled;
  const icon = cancelled ? "✗" : STATUS_ICONS[q.status] || "?";
  const tags = q.tags?.length ? `  [${q.tags.join(", ")}]` : "";
  const session = (() => {
    if (!("sessionId" in q)) return "";
    const sid = (q as { sessionId: string }).sessionId;
    return `  → ${formatSessionLabel(sid, sessionMetadata, options)}`;
  })();
  const ownership = (() => {
    const previous = (q as { previousOwnerSessionIds?: string[] }).previousOwnerSessionIds;
    if (!previous?.length) return "";
    return `  [prev:${previous.length}]`;
  })();
  const statusLabel = (() => {
    if (cancelled) return "cancelled";
    if (isVerificationInboxUnreadQuest(q)) return "review_inbox";
    if (hasQuestReviewMetadata(q)) return "under_review";
    return STATUS_LABELS[q.status] ?? q.status;
  })();
  const pad = (s: string, len: number) => s.padEnd(len);
  return `${icon} ${pad(q.questId, 6)} ${pad(q.title, 36)}${tags}${ownership}  (${statusLabel}${session})`;
}

export function formatQuestDetail(
  q: QuestmasterTask,
  sessionMetadata?: Map<string, SessionMetadata>,
  options?: FormatQuestOptions,
): string {
  const lines: string[] = [];
  lines.push(`Quest ${q.questId} (rev ${q.version}, ${STATUS_LABELS[q.status] ?? q.status})`);
  lines.push(`Title:       ${q.title}`);
  const tldr = normalizeTldr((q as { tldr?: unknown }).tldr);
  if (tldr) {
    lines.push(`TLDR:        ${tldr}`);
  }
  if ("description" in q && q.description) {
    lines.push(`Description: ${q.description}`);
  }
  if (q.tags?.length) {
    lines.push(`Tags:        ${q.tags.join(", ")}`);
  }
  if ("sessionId" in q) {
    const sid = (q as { sessionId: string }).sessionId;
    lines.push(`Session:     ${formatSessionLabel(sid, sessionMetadata, { ...options, preferSessionNum: true })}`);
  }
  const previousOwners = (q as { previousOwnerSessionIds?: string[] }).previousOwnerSessionIds;
  if (previousOwners?.length) {
    lines.push(
      `Previous:    ${previousOwners
        .map((sid) => formatSessionLabel(sid, sessionMetadata, { ...options, preferSessionNum: true }))
        .join(", ")}`,
    );
  }
  if ("claimedAt" in q) {
    lines.push(`Claimed:     ${timeAgo((q as { claimedAt: number }).claimedAt)}`);
  }
  if ("verificationItems" in q) {
    const items = (q as { verificationItems: { text: string; checked: boolean }[] }).verificationItems;
    const checked = items.filter((i) => i.checked).length;
    lines.push(`Verification: ${checked}/${items.length}`);
    lines.push(
      `Inbox:        ${hasQuestReviewMetadata(q) ? (isVerificationInboxUnreadQuest(q) ? "unread (Review Inbox)" : "acknowledged (under review)") : "n/a"}`,
    );
    for (let i = 0; i < items.length; i++) {
      lines.push(`  [${items[i].checked ? "x" : " "}] ${i}: ${items[i].text}`);
    }
  }
  if (q.commitShas?.length) {
    lines.push(`Commits:     ${q.commitShas.length}`);
    for (const sha of q.commitShas) {
      lines.push(`  ${sha}`);
    }
  }
  if ("feedback" in q) {
    const entries = (
      q as {
        feedback?: {
          author: string;
          text: string;
          ts: number;
          addressed?: boolean;
          authorSessionId?: string;
          images?: { filename: string; path: string }[];
          tldr?: string;
        }[];
      }
    ).feedback;
    if (entries?.length) {
      lines.push(`Feedback:`);
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index]!;
        const authorLabel = entry.authorSessionId
          ? `${entry.author}:${formatSessionLabel(entry.authorSessionId, sessionMetadata, {
              ...options,
              preferSessionNum: true,
            })}`
          : entry.author;
        const tag = entry.addressed
          ? `${authorLabel}, addressed, ${timeAgo(entry.ts)}`
          : `${authorLabel}, ${timeAgo(entry.ts)}`;
        const entryTldr = normalizeTldr(entry.tldr);
        lines.push(`  #${index} [${tag}] ${entryTldr ? `TLDR: ${entryTldr}` : entry.text}`);
        if (entryTldr) {
          lines.push(`    Full: ${entry.text}`);
        }
        if (entry.images?.length) {
          for (const img of entry.images) {
            lines.push(`    ${img.filename} → ${img.path}`);
          }
        }
      }
    }
  }
  if (q.images?.length) {
    lines.push(`Images:      ${q.images.length} attached`);
    for (const img of q.images) {
      lines.push(`  ${img.filename} → ${img.path}`);
    }
  }
  if ("cancelled" in q && (q as { cancelled?: boolean }).cancelled) {
    lines.push(`Cancelled:   yes`);
  }
  if ("notes" in q && (q as { notes?: string }).notes) {
    lines.push(`Notes:       ${(q as { notes: string }).notes}`);
  }
  if ("completedAt" in q) {
    lines.push(`Completed:   ${timeAgo((q as { completedAt: number }).completedAt)}`);
  }
  lines.push(`Last Active: ${timeAgo(questRecencyTs(q))}`);
  lines.push(`Created:     ${timeAgo(q.createdAt)}`);
  if (q.statusChangedAt && q.statusChangedAt !== q.createdAt) {
    lines.push(`Status:      ${timeAgo(q.statusChangedAt)}`);
  }
  return lines.join("\n");
}
