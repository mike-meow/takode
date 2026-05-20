import type { ChatMessage, SessionNotification } from "../types.js";
import {
  THREAD_OUTCOME_REMINDER_SOURCE_ID,
  THREAD_OUTCOME_REMINDER_SOURCE_LABEL,
} from "../../shared/thread-outcome-reminder.js";
import { normalizeThreadKey } from "./thread-projection.js";

export interface ThreadOutcomeReminderViewModel {
  title: string;
  rawContent: string;
  satisfiedSummary?: string;
}

export function buildThreadOutcomeReminderViewModel(
  message: Pick<ChatMessage, "agentSource" | "content" | "metadata" | "threadOutcomeReminder" | "timestamp">,
  notifications?: ReadonlyArray<SessionNotification>,
): ThreadOutcomeReminderViewModel | null {
  if (message.agentSource?.sessionId !== THREAD_OUTCOME_REMINDER_SOURCE_ID) return null;
  if (!message.content.trim()) return null;
  const satisfiedSummary = getSatisfiedSummary(message, notifications);
  return {
    title: satisfiedSummary
      ? `Historical ${THREAD_OUTCOME_REMINDER_SOURCE_LABEL}`
      : THREAD_OUTCOME_REMINDER_SOURCE_LABEL,
    rawContent: message.content,
    ...(satisfiedSummary ? { satisfiedSummary } : {}),
  };
}

function getSatisfiedSummary(
  message: Pick<ChatMessage, "content" | "metadata" | "threadOutcomeReminder" | "timestamp">,
  notifications: ReadonlyArray<SessionNotification> | undefined,
): string | undefined {
  if (message.threadOutcomeReminder?.status === "satisfied") {
    return message.threadOutcomeReminder.notificationSummary || "same-thread needs-input";
  }
  const threadKey = normalizeThreadKey(message.metadata?.threadKey ?? "main");
  const match = notifications?.find((notification) => {
    if (notification.category !== "needs-input") return false;
    if (notification.timestamp < message.timestamp) return false;
    const notificationThread = normalizeThreadKey(
      notification.threadKey ?? notification.questId ?? notification.threadRefs?.[0]?.threadKey ?? "main",
    );
    return notificationThread === threadKey;
  });
  return match?.summary || undefined;
}
