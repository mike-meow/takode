/**
 * Reply-to-message injection and parsing.
 *
 * Format:
 *   <<<REPLY_TO:msgId>>>preview text here<<<END_REPLY>>>
 *
 * The messageId is embedded in the opening tag so the browser can scroll to the
 * original message. The preview text is inserted verbatim between the delimiters
 * -- no escaping needed because the delimiters themselves are impossible in
 * natural text. The actual user message follows after the closing delimiter
 * (separated by \n\n).
 */

const REPLY_TAG_PREFIX = "<<<REPLY_TO";
const REPLY_CLOSE = "<<<END_REPLY>>>";

/** Wrap a reply preview and user message into the wire format sent to the assistant. */
export function injectReplyContext(previewText: string, userMessage: string, messageId?: string): string {
  const openTag = messageId ? `${REPLY_TAG_PREFIX}:${messageId}>>>` : `${REPLY_TAG_PREFIX}>>>`;
  return `${openTag}${previewText}${REPLY_CLOSE}\n\n${userMessage}`;
}

/** Parsed reply context extracted from a user message, or null if none. */
export interface ParsedReplyContext {
  previewText: string;
  userMessage: string;
  /** The original message ID, if embedded in the tag. Used for scroll-to behavior. */
  messageId?: string;
}

/** Extract reply context from message content. Returns null if no reply prefix is present. */
export function parseReplyContext(content: string): ParsedReplyContext | null {
  if (!content.startsWith(REPLY_TAG_PREFIX)) return null;

  // Find the closing ">>>" of the opening tag
  const openTagEnd = content.indexOf(">>>", REPLY_TAG_PREFIX.length);
  if (openTagEnd === -1) return null;

  // Extract optional messageId from "<<<REPLY_TO:msgId>>>"
  const tagMeta = content.slice(REPLY_TAG_PREFIX.length, openTagEnd);
  const messageId = tagMeta.startsWith(":") ? tagMeta.slice(1) : undefined;

  const bodyStart = openTagEnd + 3; // skip ">>>"

  const closeIdx = content.indexOf(REPLY_CLOSE, bodyStart);
  if (closeIdx === -1) return null;

  const previewText = content.slice(bodyStart, closeIdx);

  // Skip the closing delimiter + up to two newlines that separate the reply tag from the message
  let msgStart = closeIdx + REPLY_CLOSE.length;
  if (content[msgStart] === "\n") msgStart++;
  if (content[msgStart] === "\n") msgStart++;
  const userMessage = content.slice(msgStart);

  return { previewText, userMessage, messageId };
}
