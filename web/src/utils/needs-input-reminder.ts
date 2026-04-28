import type { ChatMessage, SessionNotification } from "../types.js";

export const NEEDS_INPUT_REMINDER_SOURCE_ID = "system:needs-input-reminder";

export type NeedsInputReminderEntryStatus = "active" | "resolved" | "unknown";

export interface NeedsInputReminderEntryView {
  rawId: string;
  notificationId: string;
  summary: string;
  status: NeedsInputReminderEntryStatus;
}

export interface NeedsInputReminderViewModel {
  entries: NeedsInputReminderEntryView[];
  activeCount: number;
  resolvedCount: number;
  unknownCount: number;
  title: string;
  description: string;
}

interface ParsedNeedsInputReminderEntry {
  rawId: string;
  notificationId: string;
  summary: string;
}

interface ParsedNeedsInputReminder {
  entries: ParsedNeedsInputReminderEntry[];
}

function normalizeReminderNotificationId(rawId: string): string | null {
  const trimmed = rawId.trim().toLowerCase();
  if (/^\d+$/.test(trimmed)) return `n-${Number.parseInt(trimmed, 10)}`;
  if (/^n-\d+$/.test(trimmed)) return trimmed;
  return null;
}

function parseNeedsInputReminderContent(content: string): ParsedNeedsInputReminder | null {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "[Needs-input reminder]") return null;

  const entries: ParsedNeedsInputReminderEntry[] = [];
  for (const line of lines.slice(1)) {
    const match = /^\s*(n-\d+|\d+)\.\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const notificationId = normalizeReminderNotificationId(match[1]);
    if (!notificationId) continue;
    entries.push({
      rawId: match[1],
      notificationId,
      summary: match[2].trim() || "(no summary)",
    });
  }

  return { entries };
}

function findNeedsInputNotification(
  notifications: ReadonlyArray<SessionNotification> | undefined,
  notificationId: string,
): SessionNotification | null {
  return (
    notifications?.find(
      (notification) => notification.id === notificationId && notification.category === "needs-input",
    ) ?? null
  );
}

function describeReminderCounts(activeCount: number, resolvedCount: number, unknownCount: number): string {
  if (activeCount > 0) {
    const activeLabel =
      activeCount === 1
        ? "1 referenced needs-input notification is still unresolved."
        : `${activeCount} referenced needs-input notifications are still unresolved.`;
    const historicalParts: string[] = [];
    if (resolvedCount > 0) historicalParts.push(`${resolvedCount} resolved`);
    if (unknownCount > 0) historicalParts.push(`${unknownCount} unavailable`);
    return historicalParts.length > 0 ? `${activeLabel} Historical: ${historicalParts.join(", ")}.` : activeLabel;
  }

  if (resolvedCount > 0 && unknownCount === 0) {
    return "All referenced needs-input notifications have since been resolved.";
  }
  if (resolvedCount === 0 && unknownCount > 0) {
    return "Notification state is no longer available for this historical reminder.";
  }
  if (resolvedCount > 0 && unknownCount > 0) {
    return "No referenced notifications are currently active; some notification state is no longer available.";
  }
  return "This historical reminder no longer has parseable notification references.";
}

export function buildNeedsInputReminderViewModel(
  message: Pick<ChatMessage, "agentSource" | "content">,
  notifications: ReadonlyArray<SessionNotification> | undefined,
): NeedsInputReminderViewModel | null {
  if (message.agentSource?.sessionId !== NEEDS_INPUT_REMINDER_SOURCE_ID) return null;

  const parsed = parseNeedsInputReminderContent(message.content);
  const entries =
    parsed?.entries.map((entry): NeedsInputReminderEntryView => {
      const notification = findNeedsInputNotification(notifications, entry.notificationId);
      return {
        ...entry,
        summary: notification?.summary?.trim() || entry.summary,
        status: notification ? (notification.done ? "resolved" : "active") : "unknown",
      };
    }) ?? [];

  const activeCount = entries.filter((entry) => entry.status === "active").length;
  const resolvedCount = entries.filter((entry) => entry.status === "resolved").length;
  const unknownCount = entries.filter((entry) => entry.status === "unknown").length;

  return {
    entries,
    activeCount,
    resolvedCount,
    unknownCount,
    title: activeCount > 0 ? "Needs-input reminder" : "Historical needs-input reminder",
    description: describeReminderCounts(activeCount, resolvedCount, unknownCount),
  };
}
