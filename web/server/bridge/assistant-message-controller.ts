import type { BackendType, BrowserIncomingMessage, CLIAssistantMessage } from "../session-types.js";
import { computeContextUsedPercent, resolveResultContextWindow, type TokenUsage } from "./context-usage.js";

export interface AssistantMessageSessionLike {
  backendType: BackendType;
  cliResuming: boolean;
  isGenerating: boolean;
  messageHistory: BrowserIncomingMessage[];
  assistantAccumulator: Map<string, { contentBlockIds: Set<string> }>;
  toolStartTimes: Map<string, number>;
  toolProgressOutput: Map<string, string>;
  diffStatsDirty: boolean;
  lastActivityPreview?: string;
  state: {
    model: string;
    context_used_percent: number;
  };
}

interface BroadcastOptions {
  skipBuffer?: boolean;
}

interface HandleAssistantMessageDeps {
  hasAssistantReplay: (session: AssistantMessageSessionLike, messageId: string) => boolean;
  broadcastToBrowsers: (
    session: AssistantMessageSessionLike,
    msg: BrowserIncomingMessage,
    options?: BroadcastOptions,
  ) => void;
  persistSession: (session: AssistantMessageSessionLike) => void;
}

export function handleAssistantMessage(
  session: AssistantMessageSessionLike,
  msg: CLIAssistantMessage,
  deps: HandleAssistantMessageDeps,
): void {
  const msgId = msg.message?.id;

  if (!msgId) {
    const browserMsg: BrowserIncomingMessage = {
      type: "assistant",
      message: msg.message,
      parent_tool_use_id: msg.parent_tool_use_id,
      timestamp: Date.now(),
      uuid: msg.uuid,
    };
    session.messageHistory.push(browserMsg);
    deps.broadcastToBrowsers(session, browserMsg);
    maybeUpdateContextUsedPercentFromAssistantUsage(session, msg.message.usage, msg.message.model, deps.broadcastToBrowsers);
    deps.persistSession(session);
    return;
  }

  const acc = session.assistantAccumulator.get(msgId);

  if (!acc) {
    if (deps.hasAssistantReplay(session, msgId)) {
      return;
    }

    const contentBlockIds = new Set<string>();
    const now = Date.now();
    const toolStartTimesMap: Record<string, number> = {};
    for (const block of msg.message.content) {
      if (block.type === "tool_use" && block.id) {
        contentBlockIds.add(block.id);
        if (!session.toolStartTimes.has(block.id)) {
          session.toolStartTimes.set(block.id, now);
        }
        session.toolProgressOutput.delete(block.id);
        toolStartTimesMap[block.id] = session.toolStartTimes.get(block.id)!;
      }
    }

    const browserMsg: BrowserIncomingMessage = {
      type: "assistant",
      message: { ...msg.message, content: [...msg.message.content] },
      parent_tool_use_id: msg.parent_tool_use_id,
      timestamp: Date.now(),
      uuid: msg.uuid,
      ...(Object.keys(toolStartTimesMap).length > 0 ? { tool_start_times: toolStartTimesMap } : {}),
    };
    session.assistantAccumulator.set(msgId, { contentBlockIds });
    session.messageHistory.push(browserMsg);
    deps.broadcastToBrowsers(session, browserMsg);
  } else {
    const historyEntry = session.messageHistory.findLast(
      (entry) => entry.type === "assistant" && (entry as { message?: { id?: string } }).message?.id === msgId,
    ) as
      | {
          type: "assistant";
          message: CLIAssistantMessage["message"];
          timestamp?: number;
        }
      | undefined;

    if (!historyEntry) return;

    const newBlocks = getAssistantContentAppendBlocks(historyEntry.message.content, msg.message.content, acc.contentBlockIds);
    if (newBlocks.length > 0) {
      for (const block of newBlocks) {
        if (block.type === "tool_use" && block.id) {
          if (!session.toolStartTimes.has(block.id)) {
            session.toolStartTimes.set(block.id, Date.now());
          }
          session.toolProgressOutput.delete(block.id);
        }
      }
      historyEntry.message.content = [...historyEntry.message.content, ...newBlocks];
    }

    if (msg.message.stop_reason) {
      historyEntry.message.stop_reason = msg.message.stop_reason;
    }
    if (msg.message.usage) {
      historyEntry.message.usage = msg.message.usage;
    }

    const allToolStartTimes: Record<string, number> = {};
    for (const block of historyEntry.message.content) {
      if (block.type === "tool_use" && block.id && session.toolStartTimes.has(block.id)) {
        allToolStartTimes[block.id] = session.toolStartTimes.get(block.id)!;
      }
    }

    historyEntry.timestamp = Date.now();
    deps.broadcastToBrowsers(
      session,
      {
        ...(historyEntry as BrowserIncomingMessage),
        ...(Object.keys(allToolStartTimes).length > 0 ? { tool_start_times: allToolStartTimes } : {}),
      },
      { skipBuffer: true },
    );
  }

  extractActivityPreview(session, msg.message.content);

  if (Array.isArray(msg.message.content)) {
    for (const block of msg.message.content) {
      if (block.type !== "tool_use") continue;
      const name = (block as { name?: string }).name ?? "";
      if (!READ_ONLY_TOOLS.has(name)) {
        session.diffStatsDirty = true;
        break;
      }
    }
  }

  maybeUpdateContextUsedPercentFromAssistantUsage(session, msg.message.usage, msg.message.model, deps.broadcastToBrowsers);
  deps.persistSession(session);
}

export function getAssistantContentAppendBlocks(
  existing: CLIAssistantMessage["message"]["content"],
  incoming: CLIAssistantMessage["message"]["content"],
  seenToolUseIds: Set<string>,
): CLIAssistantMessage["message"]["content"] {
  if (incoming.length === 0) return [];

  const existingSignatures = existing.map((block) => getAssistantContentBlockSignature(block));
  const incomingSignatures = incoming.map((block) => getAssistantContentBlockSignature(block));

  if (hasAssistantContentSequence(existingSignatures, incomingSignatures)) {
    return [];
  }

  const overlap = getAssistantContentOverlapLength(existingSignatures, incomingSignatures);
  const append: CLIAssistantMessage["message"]["content"] = [];

  for (let index = overlap; index < incoming.length; index++) {
    const block = incoming[index]!;
    if (block.type === "tool_use" && block.id) {
      if (seenToolUseIds.has(block.id)) continue;
      seenToolUseIds.add(block.id);
    }
    append.push(block);
  }

  return append;
}

export function extractActivityPreview(session: AssistantMessageSessionLike, content: unknown[]): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    const candidate = block as { type?: string; name?: string; input?: Record<string, unknown> };
    if (candidate.type !== "tool_use") continue;

    if (candidate.name === "TodoWrite") {
      const todos = candidate.input?.todos as { status?: string; activeForm?: string; content?: string }[] | undefined;
      if (Array.isArray(todos)) {
        const active = todos.find((todo) => todo.status === "in_progress");
        session.lastActivityPreview = active ? (active.activeForm || active.content || "").slice(0, 80) : undefined;
      }
    } else if (candidate.name === "TaskUpdate") {
      const status = candidate.input?.status as string | undefined;
      const activeForm = candidate.input?.activeForm as string | undefined;
      if (status === "in_progress" && activeForm) {
        session.lastActivityPreview = activeForm.slice(0, 80);
      }
    }
  }
}

function maybeUpdateContextUsedPercentFromAssistantUsage(
  session: AssistantMessageSessionLike,
  usage: TokenUsage | undefined,
  modelHint: string | undefined,
  broadcastToBrowsers: HandleAssistantMessageDeps["broadcastToBrowsers"],
): void {
  if (!usage) return;
  const model = session.state.model || modelHint;
  const contextWindow = resolveResultContextWindow(model, undefined);
  if (!contextWindow) return;
  const nextContextPct = computeContextUsedPercent(usage, contextWindow);
  if (typeof nextContextPct !== "number") return;
  if (session.state.context_used_percent === nextContextPct) return;
  session.state.context_used_percent = nextContextPct;
  broadcastToBrowsers(session, {
    type: "session_update",
    session: { context_used_percent: nextContextPct },
  });
}

function getAssistantContentBlockSignature(block: CLIAssistantMessage["message"]["content"][number]): string {
  return JSON.stringify(block);
}

function hasAssistantContentSequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0) return true;
  if (needle.length > haystack.length) return false;

  for (let start = 0; start <= haystack.length - needle.length; start++) {
    let matches = true;
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[start + offset] !== needle[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }

  return false;
}

function getAssistantContentOverlapLength(existing: string[], incoming: string[]): number {
  const maxOverlap = Math.min(existing.length, incoming.length);
  for (let size = maxOverlap; size > 0; size--) {
    let matches = true;
    for (let offset = 0; offset < size; offset++) {
      if (existing[existing.length - size + offset] !== incoming[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return size;
  }
  return 0;
}

const READ_ONLY_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "TaskOutput",
  "TaskStop",
]);
