import type { ChatMessage } from "../types.js";
import {
  isQuestThreadReminderContent,
  QUEST_THREAD_REMINDER_PREFIX,
  QUEST_THREAD_REMINDER_SOURCE_ID,
} from "../../shared/quest-thread-reminder.js";

export interface QuestThreadReminderViewModel {
  title: string;
  description: string;
  rawContent: string;
}

export function buildQuestThreadReminderViewModel(
  message: Pick<ChatMessage, "agentSource" | "content">,
): QuestThreadReminderViewModel | null {
  if (message.agentSource?.sessionId !== QUEST_THREAD_REMINDER_SOURCE_ID) return null;
  if (!isQuestThreadReminderContent(message.content)) return null;

  const description =
    message.content.trim().slice(QUEST_THREAD_REMINDER_PREFIX.length).trim() ||
    "Attach clearly quest-specific prior messages to the quest thread.";
  return {
    title: "Quest thread reminder",
    description,
    rawContent: message.content,
  };
}
