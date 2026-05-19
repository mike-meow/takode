import type { SessionNotification } from "../types.js";
import { getNotificationTitle } from "./notification-source-context.js";
import type { NeedsInputQuestionView } from "./notification-questions.js";

export interface TextSelectionRange {
  value: string;
  start: number;
  end: number;
}

export function insertTextAtSelection(
  currentValue: string,
  insertText: string,
  selection: TextSelectionRange | null,
): string {
  if (!selection || selection.value !== currentValue) {
    return `${currentValue}${insertText}`;
  }
  const start = Math.max(0, Math.min(selection.start, currentValue.length));
  const end = Math.max(start, Math.min(selection.end, currentValue.length));
  return `${currentValue.slice(0, start)}${insertText}${currentValue.slice(end)}`;
}

export function buildNeedsInputVoiceFocusedContext({
  notification,
  question,
  questionCount,
  sourceContext,
}: {
  notification: SessionNotification;
  question: NeedsInputQuestionView;
  questionCount: number;
  sourceContext?: string | null;
}): string {
  const lines: string[] = [];
  const title = getNotificationTitle(notification);
  if (sourceContext?.trim()) {
    lines.push("Notification source context:");
    lines.push(sourceContext.trim());
    lines.push("");
  }
  lines.push(`Needs-input prompt: ${title}`);
  if (questionCount > 1 || question.prompt.trim() !== title.trim()) {
    lines.push(`Current question: ${question.prompt}`);
  }
  if (question.suggestedAnswers.length > 0) {
    lines.push(`Suggested answers: ${question.suggestedAnswers.join(", ")}`);
  }
  return lines.join("\n");
}
