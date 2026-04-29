export const THREAD_ROUTING_REMINDER_SOURCE_ID = "system:thread-routing-reminder";
export const THREAD_ROUTING_REMINDER_SOURCE_LABEL = "Thread Routing Reminder";
export const THREAD_ROUTING_REMINDER_HEADER = "[Thread routing reminder]";

export type ThreadRoutingReminderReason = "missing" | "invalid";

export interface ThreadRoutingReminderInput {
  reason: ThreadRoutingReminderReason;
  marker?: string;
}

export function formatThreadRoutingReminderReason(input: ThreadRoutingReminderInput): string {
  if (input.reason === "invalid") {
    return input.marker ? `Invalid marker: ${input.marker}` : "Invalid thread marker";
  }
  return "Missing thread marker";
}

export function buildThreadRoutingReminderContent(input: ThreadRoutingReminderInput): string {
  const reason = formatThreadRoutingReminderReason(input);
  return [
    THREAD_ROUTING_REMINDER_HEADER,
    `${reason}. Your previous leader response was not assigned to a thread.`,
    "Resend user-visible leader text with `[thread:main]` or `[thread:q-N]` as the first line.",
    "For leader shell commands, put `# thread:main` or `# thread:q-N` as the first non-empty command line.",
  ].join("\n");
}

export function isThreadRoutingReminderContent(content: string): boolean {
  return content.split(/\r?\n/, 1)[0]?.trim() === THREAD_ROUTING_REMINDER_HEADER;
}
