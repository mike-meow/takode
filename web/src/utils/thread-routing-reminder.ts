import type { ChatMessage } from "../types.js";
import {
  isThreadRoutingReminderContent,
  THREAD_ROUTING_REMINDER_SOURCE_ID,
} from "../../shared/thread-routing-reminder.js";

export interface ThreadRoutingReminderViewModel {
  title: string;
  description: string;
  details: string[];
}

export function buildThreadRoutingReminderViewModel(
  message: Pick<ChatMessage, "agentSource" | "content">,
): ThreadRoutingReminderViewModel | null {
  if (message.agentSource?.sessionId !== THREAD_ROUTING_REMINDER_SOURCE_ID) return null;
  if (!isThreadRoutingReminderContent(message.content)) return null;

  const lines = message.content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const details = lines.slice(2);
  return {
    title: "Thread routing reminder",
    description: lines[1] || "A leader response needs an explicit thread marker before it can be routed.",
    details,
  };
}
