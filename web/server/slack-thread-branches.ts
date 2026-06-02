import type { BrowserIncomingMessage, ContentBlock, SlackThreadRecord } from "./session-types.js";

const THREAD_ID_RANDOM_BYTES = 6;
const PREVIEW_LIMIT = 140;

export function createSlackThreadId(randomUUID: () => string = crypto.randomUUID): string {
  const compact = randomUUID()
    .replace(/-/g, "")
    .slice(0, THREAD_ID_RANDOM_BYTES * 2);
  return `st-${compact || Date.now().toString(36)}`;
}

export function extractMessageText(message: BrowserIncomingMessage): string {
  if (message.type === "user_message" || message.type === "leader_user_message") return message.content;
  if (message.type === "assistant") return extractTextFromBlocks(message.message.content);
  if (message.type === "result") return message.data.result ?? "";
  return "";
}

export function previewText(text: string, limit = PREVIEW_LIMIT): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

export function findRootAssistantAnchor(
  history: BrowserIncomingMessage[],
  anchorMessageId: string,
): { message: Extract<BrowserIncomingMessage, { type: "assistant" }>; historyIndex: number; preview: string } | null {
  const historyIndex = history.findIndex((entry) => entry.type === "assistant" && entry.message.id === anchorMessageId);
  if (historyIndex < 0) return null;
  const message = history[historyIndex] as Extract<BrowserIncomingMessage, { type: "assistant" }>;
  if ((message as { slackThreadId?: string }).slackThreadId) return null;
  if (message.threadKey && message.threadKey.toLowerCase() !== "main") return null;
  return { message, historyIndex, preview: previewText(extractMessageText(message)) };
}

export function buildSlackThreadSeedPrompt(
  rootHistory: BrowserIncomingMessage[],
  anchorHistoryIndex: number,
  anchorMessageId: string,
): string {
  const transcript = rootHistory
    .slice(0, anchorHistoryIndex + 1)
    .flatMap((message, index) => {
      if (message.type === "user_message") return [`[root user ${index}]\n${message.content}`];
      if (message.type === "leader_user_message") return [`[root assistant ${index}]\n${message.content}`];
      if (message.type === "assistant") {
        const text = extractMessageText(message);
        if (!text.trim()) return [];
        const anchorSuffix = message.message.id === anchorMessageId ? " (thread anchor)" : "";
        return [`[root assistant ${index}${anchorSuffix}]\n${text}`];
      }
      return [];
    })
    .join("\n\n");

  return [
    "You are continuing a Slack-like side thread in Takode.",
    "This hidden child backend session is read-only for repository and file state.",
    "Use the root transcript below as the complete branch context. Do not assume later root messages exist.",
    "If an edit or other mutation is needed, explain the needed change and ask the user to continue in the root session or a normal quest workflow.",
    "",
    "Root branch context:",
    transcript || "(No readable root transcript was available.)",
    "",
    "Now answer the user's thread message.",
  ].join("\n");
}

export function updateSlackThreadRecordFromChildHistory(
  record: SlackThreadRecord,
  childHistory: BrowserIncomingMessage[],
): SlackThreadRecord {
  const visibleMessages = childHistory.filter(
    (message) => message.type === "user_message" || message.type === "assistant" || message.type === "result",
  );
  const lastPreviewSource = [...visibleMessages].reverse().find((message) => extractMessageText(message).trim());
  return {
    ...record,
    messageCount: visibleMessages.length,
    updatedAt: Date.now(),
    ...(lastPreviewSource ? { lastMessagePreview: previewText(extractMessageText(lastPreviewSource)) } : {}),
  };
}

function extractTextFromBlocks(blocks: ContentBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "thinking") return block.thinking;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
