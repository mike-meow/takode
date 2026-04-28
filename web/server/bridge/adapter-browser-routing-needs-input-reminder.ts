import type { BrowserIncomingMessage, BrowserOutgoingMessage, SessionNotification } from "../session-types.js";
import type {
  AdapterBrowserRoutingDeps,
  AdapterBrowserRoutingSessionLike,
} from "./adapter-browser-routing-controller.js";

type BrowserUserMessage = Extract<BrowserOutgoingMessage, { type: "user_message" }>;

function parseNotificationNumericId(notificationId: string): number | null {
  const match = /^n-(\d+)$/.exec(notificationId);
  return match ? Number.parseInt(match[1], 10) : null;
}

function formatReminderSummary(summary: string | undefined): string {
  return summary?.trim().replace(/\s+/g, " ") || "(no summary)";
}

function extractReminderNotificationIds(reminderText: string): string[] {
  const ids: string[] = [];
  for (const line of reminderText.split(/\r?\n/)) {
    const match = /^\s*(n-\d+|\d+)\.\s+/.exec(line);
    if (!match) continue;
    ids.push(match[1].startsWith("n-") ? match[1] : `n-${Number.parseInt(match[1], 10)}`);
  }
  return ids;
}

export function shouldCommitNeedsInputReminderHistoryEntry(
  reminderText: string,
  notifications: ReadonlyArray<SessionNotification> | undefined,
): boolean {
  const referencedIds = extractReminderNotificationIds(reminderText);
  if (referencedIds.length === 0) return true;

  let knownCount = 0;
  for (const notificationId of referencedIds) {
    const notification = notifications?.find(
      (entry) => entry.id === notificationId && entry.category === "needs-input",
    );
    if (!notification) continue;
    knownCount += 1;
    if (!notification.done) return true;
  }

  return knownCount !== referencedIds.length;
}

export function buildNeedsInputReminderTextForDirectUserMessage(
  session: AdapterBrowserRoutingSessionLike,
  msg: BrowserUserMessage,
  deps: Pick<AdapterBrowserRoutingDeps, "getLauncherSessionInfo">,
): string | null {
  if (msg.agentSource) return null;
  if (deps.getLauncherSessionInfo(session.id)?.isOrchestrator !== true) return null;

  const pending = (session.notifications ?? [])
    .filter((notification) => notification.category === "needs-input" && !notification.done)
    .map((notification) => ({
      ...notification,
      numericId: parseNotificationNumericId(notification.id),
    }))
    .sort((a, b) => {
      if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
      return (b.numericId ?? 0) - (a.numericId ?? 0);
    });

  if (pending.length === 0) return null;

  const visible = pending.slice(0, 3);
  const header =
    pending.length === 1
      ? "Unresolved same-session needs-input notifications: 1."
      : `Unresolved same-session needs-input notifications: ${pending.length}. Showing newest ${visible.length}.`;
  const lines = visible.map((notification) => {
    const id = notification.numericId === null ? notification.id : String(notification.numericId);
    return `  ${id}. ${formatReminderSummary(notification.summary)}`;
  });

  return [
    "[Needs-input reminder]",
    header,
    ...lines,
    "Review or resolve these before assuming the user's latest message answered them.",
  ].join("\n");
}

export function buildNeedsInputReminderHistoryEntry(
  reminderText: string,
  timestamp: number,
  idSuffix: string | number = timestamp,
): Extract<BrowserIncomingMessage, { type: "user_message" }> {
  return {
    type: "user_message",
    content: reminderText,
    timestamp,
    id: `needs-input-reminder-${idSuffix}`,
    agentSource: {
      sessionId: "system:needs-input-reminder",
      sessionLabel: "Needs Input Reminder",
    },
  };
}

export function prependNeedsInputReminderToContent(
  content: string | unknown[],
  reminderText: string | undefined,
): string | unknown[] {
  if (!reminderText) return content;
  if (typeof content === "string") return `${reminderText}\n\n${content}`;
  return [{ type: "text", text: reminderText }, ...content];
}
