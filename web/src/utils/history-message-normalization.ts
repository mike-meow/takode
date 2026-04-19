import type { BrowserIncomingMessage, ContentBlock, ChatMessage } from "../types.js";

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

export function normalizeHistoryMessageToChatMessages(
  histMsg: BrowserIncomingMessage,
  historyIndex: number,
): ChatMessage[] {
  if (histMsg.type === "user_message") {
    return [
      {
        id: histMsg.id || `hist-user-${historyIndex}`,
        role: "user",
        content: histMsg.content,
        timestamp: histMsg.timestamp,
        ...(histMsg.images?.length ? { images: histMsg.images } : {}),
        ...(histMsg.vscodeSelection ? { metadata: { vscodeSelection: histMsg.vscodeSelection } } : {}),
        ...(histMsg.agentSource ? { agentSource: histMsg.agentSource } : {}),
      },
    ];
  }

  if (histMsg.type === "assistant") {
    const msg = histMsg.message;
    return [
      {
        id: msg.id,
        role: "assistant",
        content: extractTextFromBlocks(msg.content),
        contentBlocks: msg.content,
        timestamp: histMsg.timestamp || Date.now(),
        parentToolUseId: histMsg.parent_tool_use_id,
        model: msg.model,
        stopReason: msg.stop_reason,
        cliUuid: (histMsg as Record<string, unknown>).uuid as string | undefined,
        leaderUserAddressed: (histMsg as { leader_user_addressed?: boolean }).leader_user_addressed === true,
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
    if (!result.is_error || histMsg.interrupted) return [];
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
