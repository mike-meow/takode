/**
 * Generate a progressively-unique preview of an assistant message.
 *
 * Takes non-empty lines from `targetContent` one at a time until the accumulated
 * preview is not a prefix of any string in `otherAssistantContents`. This ensures
 * the preview text uniquely identifies the target message in the conversation,
 * which is critical because the assistant has no concept of message indices.
 *
 * Caps at ~200 characters with ellipsis.
 */
export function generateReplyPreview(
  targetContent: string,
  otherAssistantContents: string[],
): string {
  const lines = targetContent.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return "(empty message)";

  const MAX_LENGTH = 200;
  let preview = "";

  for (const line of lines) {
    preview = preview ? `${preview}\n${line}` : line;

    // Check uniqueness: does any other message's content start with our preview?
    const isAmbiguous = otherAssistantContents.some((other) => other.startsWith(preview));
    if (!isAmbiguous) break;
  }

  if (preview.length > MAX_LENGTH) {
    return preview.slice(0, MAX_LENGTH) + "...";
  }
  return preview;
}
