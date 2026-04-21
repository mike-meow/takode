import type { BrowserIncomingMessage, ContentBlock, ChatMessage } from "../types.js";

interface NormalizeHistoryMessageOptions {
  includeSuccessfulResult?: boolean;
  resultRole?: ChatMessage["role"];
  fallbackTimestamp?: number;
  pendingLocalImagesByClientMsgId?: Map<string, Array<{ name: string; base64: string; mediaType: string }>>;
}

export function extractTextFromBlocks(blocks: ContentBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "thinking") return block.thinking;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function dedupeAssistantContentBlocks(blocks: ContentBlock[]): ContentBlock[] {
  const seenToolIds = new Set<string>();
  const result: ContentBlock[] = [];

  for (const block of blocks) {
    if (block.type === "tool_use" && block.id) {
      if (seenToolIds.has(block.id)) continue;
      seenToolIds.add(block.id);
    }
    result.push(block);
  }

  if (!result.some((block) => block.type === "tool_use")) return result;

  while (result.length > 1 && isReplayDuplicatedAssistantTail(result)) {
    result.pop();
  }

  return result;
}

function getReplaySensitiveBlockSignature(block: ContentBlock): string | null {
  if (block.type === "text") return `text:${block.text}`;
  if (block.type === "thinking") return `thinking:${block.thinking}`;
  return null;
}

function isReplayDuplicatedAssistantTail(blocks: ContentBlock[]): boolean {
  const tailIndex = blocks.length - 1;
  const tailSignature = getReplaySensitiveBlockSignature(blocks[tailIndex]!);
  if (!tailSignature) return false;

  for (let index = tailIndex - 1; index >= 0; index--) {
    const candidateSignature = getReplaySensitiveBlockSignature(blocks[index]!);
    if (candidateSignature !== tailSignature) continue;

    for (let between = index + 1; between < tailIndex; between++) {
      if (blocks[between]?.type === "tool_use") return true;
    }
  }

  return false;
}

export function normalizeHistoryMessageToChatMessages(
  histMsg: BrowserIncomingMessage,
  historyIndex: number,
  options: NormalizeHistoryMessageOptions = {},
): ChatMessage[] {
  const {
    includeSuccessfulResult = false,
    resultRole = "assistant",
    fallbackTimestamp,
    pendingLocalImagesByClientMsgId,
  } = options;

  if (histMsg.type === "user_message") {
    const localImages =
      typeof histMsg.client_msg_id === "string" ? pendingLocalImagesByClientMsgId?.get(histMsg.client_msg_id) : undefined;
    return [
      {
        id: histMsg.id || `hist-user-${historyIndex}`,
        role: "user",
        content: histMsg.content,
        timestamp: histMsg.timestamp,
        ...(histMsg.images?.length ? { images: histMsg.images } : {}),
        ...(localImages?.length ? { localImages } : {}),
        ...(typeof histMsg.client_msg_id === "string" ? { clientMsgId: histMsg.client_msg_id } : {}),
        ...(histMsg.vscodeSelection ? { metadata: { vscodeSelection: histMsg.vscodeSelection } } : {}),
        ...(histMsg.agentSource ? { agentSource: histMsg.agentSource } : {}),
      },
    ];
  }

  if (histMsg.type === "assistant") {
    const msg = histMsg.message;
    const normalizedContent = dedupeAssistantContentBlocks(msg.content);
    return [
      {
        id: msg.id,
        role: "assistant",
        content: extractTextFromBlocks(normalizedContent),
        contentBlocks: normalizedContent,
        timestamp: histMsg.timestamp || Date.now(),
        parentToolUseId: histMsg.parent_tool_use_id,
        model: msg.model,
        stopReason: msg.stop_reason,
        cliUuid: (histMsg as Record<string, unknown>).uuid as string | undefined,
        ...((histMsg as Record<string, unknown>).notification
          ? { notification: (histMsg as Record<string, unknown>).notification as ChatMessage["notification"] }
          : {}),
        ...(typeof (histMsg as Record<string, unknown>).turn_duration_ms === "number"
          ? { turnDurationMs: (histMsg as Record<string, unknown>).turn_duration_ms as number }
          : {}),
      },
    ];
  }

  if (histMsg.type === "compact_marker") {
    return [
      {
        id: histMsg.id || `compact-${historyIndex}`,
        role: "system",
        content: histMsg.summary || "Conversation compacted",
        timestamp: histMsg.timestamp,
        variant: "info",
      },
    ];
  }

  if (histMsg.type === "permission_denied") {
    return [
      {
        id: histMsg.id,
        role: "system",
        content: histMsg.summary,
        timestamp: histMsg.timestamp,
        variant: "denied",
      },
    ];
  }

  if (histMsg.type === "permission_approved") {
    return [
      {
        id: histMsg.id,
        role: "system",
        content: histMsg.summary,
        timestamp: histMsg.timestamp,
        variant: "approved",
        ...(histMsg.answers?.length ? { metadata: { answers: histMsg.answers } } : {}),
      },
    ];
  }

  if (histMsg.type === "task_notification") {
    if (!histMsg.summary) return [];
    return [
      {
        id: `task-notif-${histMsg.task_id || historyIndex}`,
        role: "system",
        content: histMsg.summary,
        timestamp: Date.now(),
        variant: "task_completed",
      },
    ];
  }

  if (histMsg.type === "result") {
    const result = histMsg.data as { is_error?: boolean; errors?: string[]; result?: string };
    if (!result.is_error) {
      if (!includeSuccessfulResult || histMsg.interrupted || !result.result) return [];
      return [
        {
          id: `hist-result-${historyIndex}`,
          role: resultRole,
          content: result.result,
          timestamp: fallbackTimestamp ?? Date.now(),
        },
      ];
    }
    if (histMsg.interrupted) return [];
    const errorText = result.errors?.length ? result.errors.join(", ") : result.result || "An error occurred";
    return [
      {
        id: `hist-error-${historyIndex}`,
        role: "system",
        content: `Error: ${errorText}`,
        timestamp: Date.now(),
        variant: "error",
      },
    ];
  }

  return [];
}
