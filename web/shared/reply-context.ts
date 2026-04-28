export interface ReplyContext {
  previewText: string;
  messageId?: string;
  notificationId?: string;
}

export interface ParsedReplyContext extends ReplyContext {
  userMessage: string;
}

const REPLY_TAG_PREFIX = "<<<REPLY_TO";
const REPLY_CLOSE = "<<<END_REPLY>>>";

/** Legacy wrapper kept so older stored messages and tests keep parsing. */
export function injectReplyContext(previewText: string, userMessage: string, messageId?: string): string {
  const openTag = messageId ? `${REPLY_TAG_PREFIX}:${messageId}>>>` : `${REPLY_TAG_PREFIX}>>>`;
  return `${openTag}${previewText}${REPLY_CLOSE}\n\n${userMessage}`;
}

/** Extract legacy reply context from message content. Returns null if no reply prefix is present. */
export function parseReplyContext(content: string): ParsedReplyContext | null {
  if (!content.startsWith(REPLY_TAG_PREFIX)) return null;

  const openTagEnd = content.indexOf(">>>", REPLY_TAG_PREFIX.length);
  if (openTagEnd === -1) return null;

  const tagMeta = content.slice(REPLY_TAG_PREFIX.length, openTagEnd);
  const messageId = tagMeta.startsWith(":") ? tagMeta.slice(1) : undefined;
  const bodyStart = openTagEnd + 3;

  const closeIdx = content.indexOf(REPLY_CLOSE, bodyStart);
  if (closeIdx === -1) return null;

  const previewText = content.slice(bodyStart, closeIdx);

  let msgStart = closeIdx + REPLY_CLOSE.length;
  if (content[msgStart] === "\n") msgStart++;
  if (content[msgStart] === "\n") msgStart++;
  const userMessage = content.slice(msgStart);

  return { previewText, userMessage, messageId };
}

export function formatReplyContentForAssistant(content: string, replyContext?: ReplyContext): string {
  const reply = resolveReplyContent(content, replyContext);
  if (!reply) return content;

  const preview = normalizeInlineText(reply.previewText);
  const body = reply.userMessage.trim();
  if (preview && body) return `[reply] ${preview}\n\n${body}`;
  if (preview) return `[reply] ${preview}`;
  if (body) return `[reply] ${body}`;
  return "[reply]";
}

export function formatReplyContentForPreview(content: string, replyContext?: ReplyContext): string {
  const reply = resolveReplyContent(content, replyContext);
  if (!reply) return content;

  const body = normalizeInlineText(reply.userMessage);
  const preview = normalizeInlineText(reply.previewText);
  return `[reply] ${body || preview}`.trim();
}

export function formatReplyContentForContext(content: string, replyContext?: ReplyContext): string {
  return formatReplyContentForAssistant(content, replyContext);
}

export function getDisplayReplyContext(content: string, replyContext?: ReplyContext): ParsedReplyContext | null {
  if (replyContext) {
    return { ...replyContext, userMessage: content };
  }
  return parseReplyContext(content);
}

function resolveReplyContent(content: string, replyContext?: ReplyContext): ParsedReplyContext | null {
  if (replyContext) return { ...replyContext, userMessage: content };
  return parseReplyContext(content);
}

function normalizeInlineText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}
