import { randomUUID } from "node:crypto";
import type { BrowserIncomingMessage, BrowserOutgoingMessage, SessionState } from "../session-types.js";
import { sessionTag } from "../session-tag.js";
import { inferContextWindowFromModel } from "./context-usage.js";
import type {
  AdapterBrowserRoutingDeps,
  AdapterBrowserRoutingSessionLike,
} from "./adapter-browser-routing-controller.js";
import { emitStoredUserMessageTakodeEvent } from "./user-message-takode-event.js";

type BrowserUserMessage = Extract<BrowserOutgoingMessage, { type: "user_message" }>;

export function isCliSlashCommand(session: AdapterBrowserRoutingSessionLike, trimmed: string): boolean {
  if (!trimmed.startsWith("/")) return false;
  const commandWord = trimmed.slice(1).split(/\s/)[0].toLowerCase();
  if (!commandWord || commandWord === "compact") return false;
  const knownCommands = session.state.slash_commands;
  if (!knownCommands?.length) return false;
  return knownCommands.some((cmd) => cmd.toLowerCase() === commandWord);
}

export function hasQueuedCompactRequest(session: AdapterBrowserRoutingSessionLike): boolean {
  return session.pendingMessages.some((raw) => {
    try {
      const parsed = JSON.parse(raw) as
        | { type?: string; content?: unknown; message?: { role?: string; content?: unknown } }
        | undefined;
      if (parsed?.type === "user_message") {
        return typeof parsed.content === "string" && parsed.content.trim().toLowerCase() === "/compact";
      }
      if (parsed?.type === "user") {
        return (
          parsed.message?.role === "user" &&
          typeof parsed.message.content === "string" &&
          parsed.message.content.trim().toLowerCase() === "/compact"
        );
      }
    } catch {
      return false;
    }
    return false;
  });
}

export function hasPendingForceCompact(session: AdapterBrowserRoutingSessionLike): boolean {
  return session.forceCompactPending || hasQueuedCompactRequest(session);
}

function markForceCompactPending(session: AdapterBrowserRoutingSessionLike, deps: AdapterBrowserRoutingDeps): void {
  session.forceCompactPending = true;
  session.state.is_compacting = true;
  deps.broadcastStatusChange(session, "compacting");
  deps.persistSession(session);
}

export function queueForceCompactPendingMessage(
  session: AdapterBrowserRoutingSessionLike,
  deps: AdapterBrowserRoutingDeps,
): void {
  if (session.backendType === "claude-sdk") {
    session.pendingMessages.push(JSON.stringify({ type: "user_message", content: "/compact" }));
  } else {
    session.pendingMessages.push(
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "/compact" },
        parent_tool_use_id: null,
        session_id: deps.getCliSessionId(session),
      }),
    );
  }
  markForceCompactPending(session, deps);
}

export function handleCliSlashCommand(
  session: AdapterBrowserRoutingSessionLike,
  command: string,
  deps: AdapterBrowserRoutingDeps,
): void {
  console.log(`[ws-bridge] CLI slash command intercepted for session ${sessionTag(session.id)}: ${command}`);
  const ts = Date.now();
  const wasGenerating = session.isGenerating;
  const userHistoryEntry: Extract<BrowserIncomingMessage, { type: "user_message" }> = {
    type: "user_message",
    content: command,
    timestamp: ts,
    id: deps.nextUserMessageId(ts),
  };
  session.messageHistory.push(userHistoryEntry);
  session.lastUserMessage = command;
  deps.touchUserMessage(session.id);
  deps.broadcastToBrowsers(session, userHistoryEntry);
  emitStoredUserMessageTakodeEvent(deps, session.id, userHistoryEntry, {
    historyIndex: session.messageHistory.length - 1,
    turnTarget: wasGenerating ? "queued" : "current",
  });
  if (session.claudeSdkAdapter) {
    const accepted = session.claudeSdkAdapter.sendBrowserMessage({
      type: "user_message",
      content: command,
    } satisfies BrowserUserMessage);
    if (!accepted) {
      session.pendingMessages.push(JSON.stringify({ type: "user_message", content: command }));
    }
  } else {
    deps.sendToCLI(
      session,
      JSON.stringify({
        type: "user",
        message: { role: "user", content: command },
        parent_tool_use_id: null,
        session_id: deps.getCliSessionId(session),
      }),
    );
  }
  deps.setGenerating(session, true, "cli_slash_command");
  deps.broadcastStatusChange(session, "running");
  deps.persistSession(session);
}

function formatStatusTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

function formatRateLimitStatus(
  label: string,
  limit: NonNullable<
    NonNullable<SessionState["codex_rate_limits"]>[keyof NonNullable<SessionState["codex_rate_limits"]>]
  >,
): string {
  const windowLabel =
    limit.windowDurationMins >= 60 && limit.windowDurationMins % 60 === 0
      ? `${limit.windowDurationMins / 60}h`
      : `${limit.windowDurationMins}m`;
  return `${label} ${limit.usedPercent}% of ${windowLabel} window`;
}

function buildCodexStatusText(session: AdapterBrowserRoutingSessionLike): string {
  const lines = ["Codex status", ""];
  const sessionState = session.codexAdapter?.getCurrentTurnId() || session.isGenerating ? "active" : "idle";
  lines.push(`- Session: ${sessionState}`);

  const model = session.state.model?.trim();
  if (model) lines.push(`- Model: ${model}`);

  const cwd = session.state.cwd?.trim();
  if (cwd) lines.push(`- Directory: ${cwd}`);

  const contextPercent =
    typeof session.state.context_used_percent === "number" ? session.state.context_used_percent : 0;
  const contextWindow =
    session.state.codex_token_details?.modelContextWindow ||
    inferContextWindowFromModel(session.state.model || "") ||
    0;
  if (contextWindow > 0) {
    lines.push(`- Context: ${contextPercent}% used (${formatStatusTokenCount(contextWindow)} window)`);
  } else {
    lines.push(`- Context: ${contextPercent}% used`);
  }

  const tokenDetails = session.state.codex_token_details;
  if (tokenDetails) {
    const tokenParts = [
      `${formatStatusTokenCount(tokenDetails.inputTokens)} input`,
      `${formatStatusTokenCount(tokenDetails.cachedInputTokens)} cached`,
      `${formatStatusTokenCount(tokenDetails.outputTokens)} output`,
    ];
    if (tokenDetails.reasoningOutputTokens > 0) {
      tokenParts.push(`${formatStatusTokenCount(tokenDetails.reasoningOutputTokens)} reasoning`);
    }
    lines.push(`- Tokens: ${tokenParts.join(", ")}`);
  }

  const rateLimits = session.state.codex_rate_limits;
  const rateLimitParts: string[] = [];
  if (rateLimits?.primary) rateLimitParts.push(formatRateLimitStatus("primary", rateLimits.primary));
  if (rateLimits?.secondary) rateLimitParts.push(formatRateLimitStatus("secondary", rateLimits.secondary));
  if (rateLimitParts.length > 0) {
    lines.push(`- Rate limits: ${rateLimitParts.join("; ")}`);
  }

  const reasoningEffort = session.state.codex_reasoning_effort?.trim();
  if (reasoningEffort) {
    lines.push(`- Reasoning effort: ${reasoningEffort}`);
  }

  return lines.join("\n");
}

export function handleCodexStatusCommand(
  session: AdapterBrowserRoutingSessionLike,
  deps: AdapterBrowserRoutingDeps,
): void {
  const ts = Date.now();
  const wasGenerating = session.isGenerating;
  const userHistoryEntry: Extract<BrowserIncomingMessage, { type: "user_message" }> = {
    type: "user_message",
    content: "/status",
    timestamp: ts,
    id: deps.nextUserMessageId(ts),
  };
  session.messageHistory.push(userHistoryEntry);
  session.lastUserMessage = "/status";
  deps.touchUserMessage(session.id);
  deps.broadcastToBrowsers(session, userHistoryEntry);
  emitStoredUserMessageTakodeEvent(deps, session.id, userHistoryEntry, {
    historyIndex: session.messageHistory.length - 1,
    turnTarget: wasGenerating ? "queued" : "current",
    turnId: session.codexAdapter?.getCurrentTurnId() ?? null,
  });

  if (!wasGenerating) {
    deps.setGenerating(session, true, "codex_status_command");
    deps.broadcastStatusChange(session, "running");
  }

  const assistantMessage: Extract<BrowserIncomingMessage, { type: "assistant" }> = {
    type: "assistant",
    message: {
      id: `codex-status-${randomUUID()}`,
      type: "message",
      role: "assistant",
      model: session.state.model || "",
      content: [{ type: "text", text: buildCodexStatusText(session) }],
      stop_reason: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    parent_tool_use_id: null,
    timestamp: ts,
    uuid: randomUUID(),
  };
  session.messageHistory.push(assistantMessage);
  deps.broadcastToBrowsers(session, assistantMessage);

  if (!wasGenerating) {
    const resultMessage: Extract<BrowserIncomingMessage, { type: "result" }> = {
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 0,
        duration_api_ms: 0,
        num_turns: session.state.num_turns ?? 0,
        total_cost_usd: session.state.total_cost_usd ?? 0,
        stop_reason: "end_turn",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: randomUUID(),
        session_id: session.state.session_id || session.id,
      },
    };
    session.messageHistory.push(resultMessage);
    deps.broadcastToBrowsers(session, resultMessage);
    deps.setGenerating(session, false, "codex_status_command");
  }
  deps.persistSession(session);
}

export function handleForceCompact(session: AdapterBrowserRoutingSessionLike, deps: AdapterBrowserRoutingDeps): void {
  console.log(`[ws-bridge] /compact intercepted for session ${sessionTag(session.id)}, triggering force-compact`);
  const ts = Date.now();
  const wasGenerating = session.isGenerating;
  const userHistoryEntry: Extract<BrowserIncomingMessage, { type: "user_message" }> = {
    type: "user_message",
    content: "/compact",
    timestamp: ts,
    id: deps.nextUserMessageId(ts),
  };
  session.messageHistory.push(userHistoryEntry);
  session.lastUserMessage = "/compact";
  deps.touchUserMessage(session.id);
  deps.broadcastToBrowsers(session, userHistoryEntry);
  emitStoredUserMessageTakodeEvent(deps, session.id, userHistoryEntry, {
    historyIndex: session.messageHistory.length - 1,
    turnTarget: wasGenerating ? "queued" : "current",
  });
  queueForceCompactPendingMessage(session, deps);
  deps.requestCliRelaunch?.(session.id);
}
