import type { ChatMessage, PendingCodexInput, PendingUserUpload } from "../types.js";
import type { FeedEntry, ToolMsgGroup } from "../hooks/use-feed-model.js";

export const EMPTY_MESSAGES: ChatMessage[] = [];
export const EMPTY_PENDING_CODEX_INPUTS: PendingCodexInput[] = [];
export const EMPTY_PENDING_USER_UPLOADS: PendingUserUpload[] = [];

export function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

export function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function escapeSelectorValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
}

export function getMessageFeedBlockId(messageId: string): string {
  return `message:${messageId}`;
}

export function getApprovalBatchFeedBlockId(messageId: string): string {
  return `approval:${messageId}`;
}

export function getToolGroupFeedBlockId(group: ToolMsgGroup): string {
  return `tool-group:${group.firstId || group.items[0]?.id || group.toolName}`;
}

export function getSubagentFeedBlockId(toolUseId: string): string {
  return `subagent:${toolUseId}`;
}

export function getTurnFeedBlockId(turnId: string): string {
  return `turn:${turnId}`;
}

export function getFooterFeedBlockId(kind: string): string {
  return `footer:${kind}`;
}

export function getPendingCodexFeedBlockId(inputId: string): string {
  return `pending-codex:${inputId}`;
}

function getFeedBlockIdFromNode(node: Node | null): string | null {
  const element = node instanceof Element ? node : node?.parentElement;
  return (element?.closest("[data-feed-block-id]") as HTMLElement | null)?.dataset.feedBlockId ?? null;
}

export function collectFeedBlockIdsFromNode(node: Node | null, blockIds: Set<string>) {
  const ownId = getFeedBlockIdFromNode(node);
  if (ownId) blockIds.add(ownId);
  if (!(node instanceof Element)) return;
  const element = node as HTMLElement;
  if (element.dataset.feedBlockId) blockIds.add(element.dataset.feedBlockId);
  const descendants = element.querySelectorAll<HTMLElement>("[data-feed-block-id]");
  for (const descendant of descendants) {
    if (descendant.dataset.feedBlockId) blockIds.add(descendant.dataset.feedBlockId);
  }
}

function dateBucket(timestamp: number): string | null {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function isTimedChatMessage(msg: ChatMessage): boolean {
  return msg.role === "user" || msg.role === "assistant";
}

export function appendTimedMessagesFromEntries(entries: FeedEntry[], out: ChatMessage[]) {
  for (const entry of entries) {
    if (entry.kind !== "message") continue;
    if (!isTimedChatMessage(entry.msg)) continue;
    if (entry.msg.agentSource?.sessionId === "herd-events") continue;
    out.push(entry.msg);
  }
}

export { isTimedChatMessage };

function formatMinuteBoundaryLabel(timestamp: number, previousTimestamp: number | null): string | null {
  const current = new Date(timestamp);
  if (Number.isNaN(current.getTime())) return null;

  const prev = previousTimestamp === null ? null : new Date(previousTimestamp);
  const includesDate =
    !prev ||
    current.getFullYear() !== prev.getFullYear() ||
    current.getMonth() !== prev.getMonth() ||
    current.getDate() !== prev.getDate();

  if (includesDate) {
    return current.toLocaleDateString([], {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }

  return null;
}

export function buildMinuteBoundaryLabelMap(messages: ChatMessage[]): Map<string, string> {
  const labels = new Map<string, string>();
  let prevDate: string | null = null;
  let prevTimestamp: number | null = null;

  for (const msg of messages) {
    const currentDate = dateBucket(msg.timestamp);
    if (currentDate !== null && currentDate !== prevDate) {
      const label = formatMinuteBoundaryLabel(msg.timestamp, prevTimestamp);
      if (label) labels.set(msg.id, label);
      prevDate = currentDate;
    }
    if (currentDate !== null) {
      prevTimestamp = msg.timestamp;
    }
  }

  return labels;
}

export function collectTimedMessages(entries: FeedEntry[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  appendTimedMessagesFromEntries(entries, messages);
  return messages;
}
