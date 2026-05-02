import { randomUUID } from "node:crypto";
import type { BrowserIncomingMessage } from "./session-types.js";
import {
  CodexAgentMessageItem,
  CodexCollabAgentToolCallItem,
  CodexCommandExecutionItem,
  CodexFileChangeItem,
  CodexImageViewItem,
  CodexItem,
  CodexMcpToolCallItem,
  CodexReasoningItem,
  CodexWebSearchItem,
  PendingSubagentToolUse,
  ToolFileChange,
  extractWebSearchQuery,
  extractWebSearchResultText,
  firstNonEmptyString,
  formatCommandForDisplay,
  hasAnyPatchDiff,
  isWriteLikeFileChangeKind,
  mapUnknownFileChangesForTool,
  parseToolArguments,
  safeKind,
  toSafeText,
} from "./codex-adapter-utils.js";

type EmitFn = (msg: BrowserIncomingMessage) => void;

type ToolEmitOptions = {
  parentToolUseId?: string | null;
  timestamp?: number;
};

type RouterFailureToolName = "write_stdin";

type TerminalInteractionToolUse = {
  toolUseId: string;
  commandToolUseId: string;
  processId: string;
  stdin: string;
  parentToolUseId: string | null;
};

export class CodexItemEventManager {
  private streamingText = "";
  private streamingItemId: string | null = null;

  private commandStartTimes = new Map<string, number>();
  private commandOutputByItemId = new Map<string, string>();
  private planToolUseSeq = 0;
  private terminalInteractionToolUseSeq = 0;
  private planSignatureByKey = new Map<string, string>();

  private reasoningTextByItemId = new Map<string, string>();
  private reasoningTimeFromLastMessageByItemId = new Map<string, number>();
  private lastMessageFinishedAt: number | null = null;

  private emittedToolUseIds = new Set<string>();
  private emittedToolUseInputsById = new Map<string, Record<string, unknown>>();
  private emittedToolUseNamesById = new Map<string, string>();
  private emittedToolResultIds = new Set<string>();
  private activeToolUseIds = new Set<string>();
  private terminalInteractionByProcessId = new Map<string, TerminalInteractionToolUse>();
  private failedTerminalRouterErrorKeys = new Set<string>();
  private patchChangesByCallId = new Map<string, ToolFileChange[]>();
  private parentToolUseIdByThreadId = new Map<string, string>();
  private parentToolUseIdByItemId = new Map<string, string | null>();
  private pendingSubagentToolUsesByCallId = new Map<string, PendingSubagentToolUse>();

  constructor(
    private readonly emit: EmitFn,
    private readonly options: { model?: string },
  ) {}

  dispose(): void {
    this.streamingText = "";
    this.streamingItemId = null;
    this.commandStartTimes.clear();
    this.commandOutputByItemId.clear();
    this.planSignatureByKey.clear();
    this.reasoningTextByItemId.clear();
    this.reasoningTimeFromLastMessageByItemId.clear();
    this.emittedToolUseIds.clear();
    this.emittedToolUseInputsById.clear();
    this.emittedToolUseNamesById.clear();
    this.emittedToolResultIds.clear();
    this.activeToolUseIds.clear();
    this.terminalInteractionByProcessId.clear();
    this.failedTerminalRouterErrorKeys.clear();
    this.patchChangesByCallId.clear();
    this.parentToolUseIdByThreadId.clear();
    this.parentToolUseIdByItemId.clear();
    this.pendingSubagentToolUsesByCallId.clear();
    this.lastMessageFinishedAt = null;
  }

  markMessageFinished(timestamp: number): void {
    this.lastMessageFinishedAt = timestamp;
  }

  cachePatchApplyChanges(params: Record<string, unknown>): void {
    const msg = params.msg as Record<string, unknown> | undefined;
    if (!msg || typeof msg !== "object") return;
    const callId = toSafeText(msg.call_id ?? msg.callId).trim();
    if (!callId) return;
    const changes = mapUnknownFileChangesForTool(msg.changes);
    if (changes.length > 0) {
      this.patchChangesByCallId.set(callId, changes);
    }
  }

  resolveParentToolUseId(params: Record<string, unknown>, itemId?: string): string | null {
    if (itemId && this.parentToolUseIdByItemId.has(itemId)) {
      return this.parentToolUseIdByItemId.get(itemId) ?? null;
    }
    return this.getParentToolUseIdForThreadId(this.getThreadIdFromParams(params));
  }

  handleSubagentTaskComplete(params: Record<string, unknown>): void {
    const msg = params.msg as Record<string, unknown> | undefined;
    const threadId = this.getThreadIdFromParams(params);
    const toolUseId = this.getParentToolUseIdForThreadId(threadId);
    if (!toolUseId) return;

    const resultText =
      toSafeText(
        msg?.last_agent_message ??
          params.last_agent_message ??
          msg?.summary ??
          params.summary ??
          msg?.message ??
          params.message,
      ).trim() || "Subagent completed";

    const parentToolUseId = this.pendingSubagentToolUsesByCallId.get(toolUseId)?.parentToolUseId ?? null;
    this.emitToolResult(toolUseId, resultText, false, parentToolUseId);
  }

  handleItemStarted(params: Record<string, unknown>): void {
    const item = params.item as CodexItem;
    if (!item) return;
    const parentToolUseId = this.resolveParentToolUseId(params, item.id);
    this.parentToolUseIdByItemId.set(item.id, parentToolUseId);

    switch (item.type) {
      case "agentMessage":
        this.streamingItemId = item.id;
        this.streamingText = "";
        this.emit({
          type: "stream_event",
          event: {
            type: "message_start",
            message: {
              id: this.makeMessageId("agent", item.id),
              type: "message",
              role: "assistant",
              model: this.options.model || "",
              content: [],
              stop_reason: null,
              usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            },
          },
          parent_tool_use_id: parentToolUseId,
        });
        this.emit({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          parent_tool_use_id: parentToolUseId,
        });
        break;

      case "commandExecution": {
        const cmd = item as CodexCommandExecutionItem;
        const commandStr = formatCommandForDisplay(cmd.command, cmd.commandActions);
        this.commandStartTimes.set(item.id, Date.now());
        this.commandOutputByItemId.delete(item.id);
        this.emitToolUseStart(item.id, "Bash", { command: commandStr }, { parentToolUseId });
        break;
      }

      case "fileChange": {
        const fc = item as CodexFileChangeItem;
        const fileChangeTool = this.buildFileChangeTool(item.id, fc.changes);
        if (!fileChangeTool) {
          break;
        }
        this.emitToolUseStart(item.id, fileChangeTool.toolName, fileChangeTool.input, { parentToolUseId });
        break;
      }

      case "mcpToolCall": {
        const mcp = item as CodexMcpToolCallItem;
        this.emitToolUseStart(item.id, `mcp:${mcp.server}:${mcp.tool}`, mcp.arguments || {}, { parentToolUseId });
        break;
      }

      case "webSearch": {
        const ws = item as CodexWebSearchItem;
        this.emitToolUseStart(item.id, "WebSearch", { query: extractWebSearchQuery(ws) }, { parentToolUseId });
        break;
      }

      case "imageView": {
        const imageView = item as CodexImageViewItem;
        this.emitToolUseStart(item.id, "view_image", { path: imageView.path || "" }, { parentToolUseId });
        break;
      }

      case "reasoning": {
        const r = item as CodexReasoningItem;
        this.reasoningTextByItemId.set(item.id, r.summary || r.content || "");
        if (typeof this.lastMessageFinishedAt === "number") {
          this.reasoningTimeFromLastMessageByItemId.set(item.id, Math.max(0, Date.now() - this.lastMessageFinishedAt));
        }
        if (r.summary || r.content) {
          this.emit({
            type: "stream_event",
            event: {
              type: "content_block_start",
              index: 0,
              content_block: { type: "thinking", thinking: r.summary || r.content || "" },
            },
            parent_tool_use_id: parentToolUseId,
          });
        }
        break;
      }

      case "collabAgentToolCall": {
        const collab = item as CodexCollabAgentToolCallItem;
        if (collab.tool !== "spawnAgent") break;
        const senderThreadId = toSafeText(collab.senderThreadId).trim() || this.getThreadIdFromParams(params);
        this.pendingSubagentToolUsesByCallId.set(item.id, {
          prompt: toSafeText(collab.prompt).trim(),
          startedAt: Date.now(),
          senderThreadId: senderThreadId || null,
          parentToolUseId: this.getParentToolUseIdForThreadId(senderThreadId),
        });
        break;
      }

      case "contextCompaction":
        this.emit({ type: "status_change", status: "compacting" });
        break;

      default:
        break;
    }
  }

  handleReasoningDelta(params: Record<string, unknown>): void {
    const itemId = params.itemId as string | undefined;
    if (!itemId) return;

    if (!this.reasoningTextByItemId.has(itemId)) {
      this.reasoningTextByItemId.set(itemId, "");
    }

    const delta =
      typeof params.delta === "string"
        ? params.delta
        : typeof params.text === "string"
          ? params.text
          : params.part &&
              typeof params.part === "object" &&
              typeof (params.part as Record<string, unknown>).text === "string"
            ? ((params.part as Record<string, unknown>).text as string)
            : undefined;
    if (!delta) return;

    const current = this.reasoningTextByItemId.get(itemId) || "";
    this.reasoningTextByItemId.set(itemId, current + delta);
    this.emit({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: delta },
      },
      parent_tool_use_id: this.resolveParentToolUseId(params, itemId),
    });
  }

  handleAgentMessageDelta(params: Record<string, unknown>): void {
    const itemId = params.itemId as string | undefined;
    const delta = params.delta as string;
    if (!delta) return;

    this.streamingText += delta;
    this.emit({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: delta },
      },
      parent_tool_use_id: this.resolveParentToolUseId(params, itemId),
    });
  }

  handleItemUpdated(_params: Record<string, unknown>): void {
    // item/updated is a general update — currently we handle streaming via specific delta events.
  }

  handleTerminalInteraction(params: Record<string, unknown>): void {
    const itemId = toSafeText(params.itemId).trim();
    const processId = toSafeText(params.processId).trim();
    if (!itemId || !processId) return;

    const stdin = typeof params.stdin === "string" ? params.stdin : "";
    const parentToolUseId = this.resolveParentToolUseId(params, itemId);
    const toolUseId = `${itemId}:terminal:${++this.terminalInteractionToolUseSeq}`;

    this.emitToolUseTracked(
      toolUseId,
      "write_stdin",
      {
        session_id: processId,
        chars: stdin,
      },
      { parentToolUseId },
    );

    const summary =
      stdin.length === 0
        ? `Polled session ${processId} via write_stdin(chars="").`
        : `Sent stdin to session ${processId} via write_stdin.`;
    this.emitToolResult(toolUseId, summary, false, parentToolUseId);
    this.rememberTerminalInteraction({
      toolUseId,
      commandToolUseId: itemId,
      processId,
      stdin,
      parentToolUseId,
    });
  }

  handleRawResponseItemCompleted(params: Record<string, unknown>): void {
    const item =
      (params.item && typeof params.item === "object" ? (params.item as Record<string, unknown>) : null) ??
      (params.responseItem && typeof params.responseItem === "object"
        ? (params.responseItem as Record<string, unknown>)
        : null) ??
      (params.rawResponseItem && typeof params.rawResponseItem === "object"
        ? (params.rawResponseItem as Record<string, unknown>)
        : null);
    if (!item) return;

    const itemType = toSafeText(item.type).trim().toLowerCase();
    if (itemType !== "function_call") return;

    const toolName = toSafeText(item.name).trim();
    if (toolName !== "view_image") return;

    const toolUseId = toSafeText(item.call_id ?? item.callId ?? item.id).trim() || `raw-${randomUUID()}`;
    const toolInput = parseToolArguments(item.arguments);
    const parentToolUseId = this.resolveParentToolUseId(params, toolUseId);
    this.ensureToolUseData(toolUseId, toolName, toolInput, { parentToolUseId }, true);
    this.emitToolResultOnce(toolUseId, this.buildImageViewResultText(toolInput.path), false, parentToolUseId);
  }

  emitPlanTodoWrite(params: Record<string, unknown>, source: "item_plan_delta" | "turn_plan_updated"): void {
    const todos = this.extractPlanTodos(params);
    const key = toSafeText(params.turnId ?? params.itemId ?? params.threadId ?? source) || source;
    const signature = JSON.stringify(todos);
    const previousSignature = this.planSignatureByKey.get(key);
    if (previousSignature === signature) return;
    if (todos.length === 0) {
      if (previousSignature == null) return;
      this.planSignatureByKey.delete(key);
    } else {
      this.planSignatureByKey.set(key, signature);
    }

    const toolUseId = `codex-plan-${key}-${++this.planToolUseSeq}`;
    this.emitToolUseTracked(
      toolUseId,
      "TodoWrite",
      { todos },
      {
        parentToolUseId: this.resolveParentToolUseId(params, toolUseId),
      },
    );
  }

  handleItemCompleted(params: Record<string, unknown>): void {
    const item = params.item as CodexItem;
    if (!item) return;
    const parentToolUseId = this.resolveParentToolUseId(params, item.id);
    this.activeToolUseIds.delete(item.id);
    this.clearTerminalInteractionsForCommand(item.id);

    switch (item.type) {
      case "agentMessage": {
        const agentMsg = item as CodexAgentMessageItem;
        const text = agentMsg.text || this.streamingText;
        const completedAt = Date.now();

        this.emit({
          type: "stream_event",
          event: {
            type: "content_block_stop",
            index: 0,
          },
          parent_tool_use_id: parentToolUseId,
        });
        this.emit({
          type: "stream_event",
          event: {
            type: "message_delta",
            delta: { stop_reason: null },
            usage: { output_tokens: 0 },
          },
          parent_tool_use_id: parentToolUseId,
        });
        this.emit({
          type: "assistant",
          message: {
            id: this.makeMessageId("agent", item.id),
            type: "message",
            role: "assistant",
            model: this.options.model || "",
            content: [{ type: "text", text }],
            stop_reason: "end_turn",
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          parent_tool_use_id: parentToolUseId,
          timestamp: completedAt,
        });
        this.markMessageFinished(completedAt);
        this.streamingText = "";
        this.streamingItemId = null;
        break;
      }

      case "commandExecution": {
        const cmd = item as CodexCommandExecutionItem;
        const commandStr = formatCommandForDisplay(cmd.command, cmd.commandActions);
        this.ensureToolUseEmitted(item.id, "Bash", { command: commandStr }, { parentToolUseId });
        this.commandStartTimes.delete(item.id);
        const streamedOutput = (this.commandOutputByItemId.get(item.id) || "").trim();
        this.commandOutputByItemId.delete(item.id);
        const cmdRecord = item as Record<string, unknown>;
        const output = firstNonEmptyString(cmdRecord, [
          "stdout",
          "aggregatedOutput",
          "aggregated_output",
          "formatted_output",
          "output",
        ]);
        const stderr = firstNonEmptyString(cmdRecord, ["stderr", "errorOutput", "error_output"]);
        const directOutput = [output, stderr].filter(Boolean).join("\n").trim();
        const combinedOutput = directOutput || streamedOutput;
        const exitCode = typeof cmd.exitCode === "number" ? cmd.exitCode : 0;
        const durationMs = typeof cmd.durationMs === "number" ? cmd.durationMs : undefined;
        const failed = cmd.status === "failed" || cmd.status === "declined" || exitCode !== 0;

        if (!combinedOutput && !failed) {
          break;
        }

        let resultText = combinedOutput;
        if (!resultText) {
          resultText = `Exit code: ${exitCode}`;
        } else if (exitCode !== 0) {
          resultText = `${resultText}\nExit code: ${exitCode}`;
        }
        if (durationMs !== undefined && durationMs >= 100) {
          const durationStr = durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${durationMs}ms`;
          resultText = `${resultText}\n(${durationStr})`;
        }

        this.emitToolResult(item.id, resultText, failed, parentToolUseId);
        break;
      }

      case "fileChange": {
        const fc = item as CodexFileChangeItem;
        const fileChangeTool = this.buildFileChangeTool(item.id, fc.changes);
        if (fileChangeTool) {
          this.ensureToolUseEmitted(item.id, fileChangeTool.toolName, fileChangeTool.input, { parentToolUseId });
        }
        if (!fileChangeTool && !this.emittedToolUseIds.has(item.id)) {
          this.patchChangesByCallId.delete(item.id);
          break;
        }
        const changes = fileChangeTool
          ? Array.isArray(fileChangeTool.input.changes)
            ? (fileChangeTool.input.changes as ToolFileChange[])
            : []
          : this.resolveFileChangesForTool(item.id, fc.changes);
        const summary = changes.map((c) => `${safeKind(c.kind)}: ${c.path}`).join("\n");
        this.emitToolResult(item.id, summary || "File changes applied", fc.status === "failed", parentToolUseId);
        this.patchChangesByCallId.delete(item.id);
        break;
      }

      case "mcpToolCall": {
        const mcp = item as CodexMcpToolCallItem;
        this.ensureToolUseEmitted(item.id, `mcp:${mcp.server}:${mcp.tool}`, mcp.arguments || {}, { parentToolUseId });
        this.emitToolResult(
          item.id,
          mcp.result || mcp.error || "MCP tool call completed",
          mcp.status === "failed",
          parentToolUseId,
        );
        break;
      }

      case "webSearch": {
        const ws = item as CodexWebSearchItem;
        const wsQuery = extractWebSearchQuery(ws);
        this.ensureToolUseEmitted(item.id, "WebSearch", { query: wsQuery }, { parentToolUseId });
        const wsResult = extractWebSearchResultText(ws);
        if (wsResult && wsResult !== wsQuery && wsResult !== "Web search completed") {
          this.emitToolResult(item.id, wsResult, false, parentToolUseId);
        }
        break;
      }

      case "imageView": {
        const imageView = item as CodexImageViewItem;
        const toolInput = { path: imageView.path || "" };
        this.ensureToolUseData(item.id, "view_image", toolInput, { parentToolUseId });
        this.emitToolResultOnce(item.id, this.buildImageViewResultText(toolInput.path), false, parentToolUseId);
        break;
      }

      case "reasoning": {
        const r = item as CodexReasoningItem;
        const bufferedText = toSafeText(this.reasoningTextByItemId.get(item.id)).trim();
        const fallbackText = toSafeText(r.summary ?? r.content ?? "").trim();
        const thinkingText = bufferedText || fallbackText;
        const completedAt = Date.now();
        let thinkingTimeMs = this.reasoningTimeFromLastMessageByItemId.get(item.id);
        if (thinkingTimeMs === undefined && typeof this.lastMessageFinishedAt === "number") {
          thinkingTimeMs = Math.max(0, completedAt - this.lastMessageFinishedAt);
        }

        if (thinkingText) {
          this.emit({
            type: "assistant",
            message: {
              id: this.makeMessageId("reasoning", item.id),
              type: "message",
              role: "assistant",
              model: this.options.model || "",
              content: [
                {
                  type: "thinking",
                  thinking: thinkingText,
                  ...(thinkingTimeMs !== undefined ? { thinking_time_ms: thinkingTimeMs } : {}),
                },
              ],
              stop_reason: null,
              usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            },
            parent_tool_use_id: parentToolUseId,
            timestamp: completedAt,
          });
          this.markMessageFinished(completedAt);
        }

        this.reasoningTextByItemId.delete(item.id);
        this.reasoningTimeFromLastMessageByItemId.delete(item.id);
        this.emit({
          type: "stream_event",
          event: {
            type: "content_block_stop",
            index: 0,
          },
          parent_tool_use_id: parentToolUseId,
        });
        break;
      }

      case "collabAgentToolCall": {
        const collab = item as CodexCollabAgentToolCallItem;
        if (collab.tool !== "spawnAgent") break;

        const pending = this.pendingSubagentToolUsesByCallId.get(item.id);
        const role = this.extractSubagentRole(collab);
        const description = this.extractSubagentLabel(collab) || role || "Subagent";
        const effectiveParentToolUseId = pending?.parentToolUseId ?? parentToolUseId;
        const input: Record<string, unknown> = {
          prompt: toSafeText(collab.prompt).trim() || pending?.prompt || "",
          description,
          subagent_type: role,
        };

        this.ensureToolUseEmitted(item.id, "Agent", input, {
          parentToolUseId: effectiveParentToolUseId,
          timestamp: pending?.startedAt,
        });

        if (Array.isArray(collab.receiverThreadIds)) {
          for (const threadId of collab.receiverThreadIds) {
            if (typeof threadId === "string" && threadId.trim()) {
              this.parentToolUseIdByThreadId.set(threadId, item.id);
            }
          }
        }

        if (collab.status === "failed" || collab.status === "declined") {
          const errorText = toSafeText(collab.error).trim() || "Subagent failed";
          this.emitToolResult(item.id, errorText, true, effectiveParentToolUseId);
        }
        break;
      }

      case "contextCompaction":
        this.emit({ type: "status_change", status: null });
        break;

      default:
        break;
    }
  }

  emitCommandProgress(params: Record<string, unknown>): void {
    const itemId = params.itemId as string | undefined;
    if (!itemId) return;
    const startTime = this.commandStartTimes.get(itemId);
    const elapsed = startTime ? Math.round((Date.now() - startTime) / 1000) : 0;
    const deltaText = this.extractCommandOutputDelta(params);
    if (deltaText) {
      const prev = this.commandOutputByItemId.get(itemId) || "";
      this.commandOutputByItemId.set(itemId, prev + deltaText);
    }
    this.emit({
      type: "tool_progress",
      tool_use_id: itemId,
      tool_name: "Bash",
      elapsed_time_seconds: elapsed,
      ...(deltaText ? { output_delta: deltaText } : {}),
    });
  }

  emitToolUseTracked(
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
    options?: ToolEmitOptions,
  ): void {
    this.emittedToolUseIds.add(toolUseId);
    this.emittedToolUseInputsById.set(toolUseId, input);
    this.emittedToolUseNamesById.set(toolUseId, toolName);
    if (this.isResultBearingToolUse(toolUseId, toolName)) {
      this.activeToolUseIds.add(toolUseId);
    }
    this.emitToolUse(toolUseId, toolName, input, options);
  }

  emitToolResult(toolUseId: string, content: unknown, isError: boolean, parentToolUseId?: string | null): void {
    this.activeToolUseIds.delete(toolUseId);
    const safeContent = typeof content === "string" ? content : JSON.stringify(content);
    const completedAt = Date.now();
    this.emit({
      type: "assistant",
      message: {
        id: this.makeMessageId("tool_result", toolUseId),
        type: "message",
        role: "assistant",
        model: this.options.model || "",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: safeContent,
            is_error: isError,
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: parentToolUseId ?? null,
      timestamp: completedAt,
    });
    this.markMessageFinished(completedAt);
  }

  handleToolRouterError(message: string, targetToolName?: RouterFailureToolName): boolean {
    if (targetToolName === "write_stdin") {
      if (this.handleWriteStdinRouterError(message)) return true;
      return this.handleActiveToolRouterError(message, "write_stdin");
    }
    return this.handleActiveToolRouterError(message);
  }

  private handleActiveToolRouterError(message: string, targetToolName?: RouterFailureToolName): boolean {
    if (this.activeToolUseIds.size !== 1) return false;
    const activeToolUseId = Array.from(this.activeToolUseIds).at(-1);
    if (!activeToolUseId) return false;
    if (targetToolName && this.emittedToolUseNamesById.get(activeToolUseId) !== targetToolName) return false;
    const parentToolUseId = this.parentToolUseIdByItemId.get(activeToolUseId) ?? null;
    this.emitToolResultOnce(activeToolUseId, message, true, parentToolUseId);
    return true;
  }

  private handleWriteStdinRouterError(message: string): boolean {
    const processId = this.extractWriteStdinFailureProcessId(message);
    if (!processId) return false;
    const interaction = this.terminalInteractionByProcessId.get(processId);
    if (!interaction) return false;
    if (!this.activeToolUseIds.has(interaction.commandToolUseId)) return false;

    const duplicateKey = `${interaction.toolUseId}\n${message}`;
    if (this.failedTerminalRouterErrorKeys.has(duplicateKey)) return true;
    this.failedTerminalRouterErrorKeys.add(duplicateKey);

    const failedToolUseId = `${interaction.commandToolUseId}:terminal-error:${++this.terminalInteractionToolUseSeq}`;
    this.emitToolUseTracked(
      failedToolUseId,
      "write_stdin",
      {
        session_id: interaction.processId,
        chars: interaction.stdin,
      },
      { parentToolUseId: interaction.parentToolUseId },
    );
    this.emitToolResult(failedToolUseId, message, true, interaction.parentToolUseId);
    return true;
  }

  private extractWriteStdinFailureProcessId(message: string): string | null {
    const match = message.match(/\bUnknown process id\s+([^\s,.]+)/i);
    return match?.[1]?.trim() || null;
  }

  private clearTerminalInteractionsForCommand(commandToolUseId: string): void {
    for (const [processId, interaction] of this.terminalInteractionByProcessId) {
      if (interaction.commandToolUseId !== commandToolUseId) continue;
      this.terminalInteractionByProcessId.delete(processId);
      this.clearFailedTerminalRouterErrorKeysForInteraction(interaction);
    }
  }

  private rememberTerminalInteraction(interaction: TerminalInteractionToolUse): void {
    const previous = this.terminalInteractionByProcessId.get(interaction.processId);
    if (previous) this.clearFailedTerminalRouterErrorKeysForInteraction(previous);
    this.terminalInteractionByProcessId.set(interaction.processId, interaction);
  }

  private clearFailedTerminalRouterErrorKeysForInteraction(interaction: TerminalInteractionToolUse): void {
    for (const key of this.failedTerminalRouterErrorKeys) {
      if (key.startsWith(`${interaction.toolUseId}\n`)) {
        this.failedTerminalRouterErrorKeys.delete(key);
      }
    }
  }

  private isResultBearingToolUse(toolUseId: string, toolName: string): boolean {
    return !toolUseId.startsWith("codex-plan-") && toolName !== "TodoWrite" && toolName !== "TaskUpdate";
  }

  private resolveFileChangesForTool(toolUseId: string, rawChanges: unknown): ToolFileChange[] {
    const direct = mapUnknownFileChangesForTool(rawChanges);
    const cached = this.patchChangesByCallId.get(toolUseId) || [];
    if (cached.length === 0) return direct;
    if (direct.length === 0) return cached;
    if (!hasAnyPatchDiff(direct) && hasAnyPatchDiff(cached)) return cached;
    return direct;
  }

  private buildFileChangeTool(
    toolUseId: string,
    rawChanges: unknown,
  ): { toolName: "Edit" | "Write"; input: { file_path: string; changes: ToolFileChange[] } } | null {
    const changes = this.resolveFileChangesForTool(toolUseId, rawChanges);
    const firstChange = changes[0];
    if (!firstChange) return null;

    const toolName: "Edit" | "Write" = isWriteLikeFileChangeKind(firstChange.kind) ? "Write" : "Edit";
    const input = {
      file_path: firstChange.path || "",
      changes,
    };
    return this.hasRenderableFileChangeInput(input) ? { toolName, input } : null;
  }

  private hasRenderableFileChangeInput(input: { file_path: string; changes: ToolFileChange[] }): boolean {
    if (
      firstNonEmptyString(input as Record<string, unknown>, [
        "content",
        "text",
        "new_string",
        "newText",
        "new_content",
        "newContent",
      ])
    ) {
      return true;
    }

    return input.changes.some((change) => {
      if (typeof change.diff === "string" && change.diff.trim()) return true;
      return (
        firstNonEmptyString(change as Record<string, unknown>, [
          "content",
          "text",
          "new_string",
          "newText",
          "new_content",
          "newContent",
        ]) !== ""
      );
    });
  }

  private getThreadIdFromRecord(record: Record<string, unknown> | undefined): string | null {
    if (!record) return null;
    const threadId = toSafeText(
      record.threadId ??
        record.senderThreadId ??
        record.conversationId ??
        record.conversation_id ??
        record.new_thread_id,
    ).trim();
    return threadId || null;
  }

  private getThreadIdFromParams(params: Record<string, unknown>): string | null {
    const direct = this.getThreadIdFromRecord(params);
    if (direct) return direct;

    for (const key of ["item", "turn", "msg"]) {
      const value = params[key];
      if (value && typeof value === "object") {
        const nested = this.getThreadIdFromRecord(value as Record<string, unknown>);
        if (nested) return nested;
      }
    }

    return null;
  }

  private getParentToolUseIdForThreadId(threadId: string | null | undefined): string | null {
    if (!threadId) return null;
    return this.parentToolUseIdByThreadId.get(threadId) ?? null;
  }

  private extractSubagentRole(item: CodexCollabAgentToolCallItem): string {
    if (Array.isArray(item.agentsStates)) {
      for (const agentState of item.agentsStates) {
        if (!agentState || typeof agentState !== "object") continue;
        const role = toSafeText((agentState as Record<string, unknown>).role).trim();
        if (role) return role;
      }
    }
    return "";
  }

  private extractSubagentLabel(item: CodexCollabAgentToolCallItem): string {
    if (Array.isArray(item.agentsStates)) {
      for (const agentState of item.agentsStates) {
        if (!agentState || typeof agentState !== "object") continue;
        const rec = agentState as Record<string, unknown>;
        const nickname = toSafeText(rec.nickname ?? rec.agentNickname ?? rec.name).trim();
        if (nickname) return nickname;
      }
    }
    return "";
  }

  private normalizePlanStatus(value: unknown): "pending" | "in_progress" | "completed" {
    const status = toSafeText(value).toLowerCase();
    if (status.includes("done") || status.includes("complete") || status.includes("finished")) return "completed";
    if (
      status.includes("progress") ||
      status.includes("doing") ||
      status.includes("active") ||
      status.includes("running") ||
      status.includes("current")
    ) {
      return "in_progress";
    }
    return "pending";
  }

  private extractPlanTodos(
    params: Record<string, unknown>,
  ): Array<{ content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string }> {
    const todos: Array<{ content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string }> = [];
    const seen = new Set<unknown>();

    const pushTodo = (value: unknown): void => {
      if (typeof value === "string") {
        const content = value.trim();
        if (content) todos.push({ content, status: "pending" });
        return;
      }
      if (!value || typeof value !== "object") return;
      const rec = value as Record<string, unknown>;
      const content = toSafeText(
        rec.content ?? rec.text ?? rec.title ?? rec.step ?? rec.name ?? rec.description ?? rec.task,
      ).trim();
      if (!content) return;
      const activeForm = toSafeText(rec.activeForm ?? rec.active_form ?? rec.inProgressForm).trim() || undefined;
      todos.push({ content, status: this.normalizePlanStatus(rec.status ?? rec.state), activeForm });
    };

    const walk = (value: unknown): void => {
      if (value == null || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        for (const entry of value) {
          pushTodo(entry);
          walk(entry);
        }
        return;
      }
      if (typeof value !== "object") return;
      const rec = value as Record<string, unknown>;
      for (const key of ["todos", "steps", "items", "plan", "checklist", "tasks", "value", "delta"]) {
        if (key in rec) walk(rec[key]);
      }
    };

    walk(params);
    if (todos.length > 0) return todos;

    const rawDelta = toSafeText(params.delta ?? params.text ?? params.plan ?? "");
    if (!rawDelta) return todos;
    for (const line of rawDelta.split("\n")) {
      const match = line.match(/^\s*[-*]\s*\[([ xX])\]\s+(.+)$/);
      if (!match) continue;
      todos.push({
        content: match[2].trim(),
        status: match[1].toLowerCase() === "x" ? "completed" : "pending",
      });
    }
    return todos;
  }

  private emitToolUse(
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
    options?: ToolEmitOptions,
  ): void {
    const now = options?.timestamp ?? Date.now();
    this.emit({
      type: "assistant",
      message: {
        id: this.makeMessageId("tool_use", toolUseId),
        type: "message",
        role: "assistant",
        model: this.options.model || "",
        content: [
          {
            type: "tool_use",
            id: toolUseId,
            name: toolName,
            input,
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: options?.parentToolUseId ?? null,
      timestamp: now,
      tool_start_times: { [toolUseId]: now },
    });
  }

  private emitToolUseStart(
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
    options?: ToolEmitOptions,
  ): void {
    this.emit({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: toolUseId, name: toolName, input: {} },
      },
      parent_tool_use_id: options?.parentToolUseId ?? null,
    });
    this.emitToolUseTracked(toolUseId, toolName, input, options);
  }

  private ensureToolUseEmitted(
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
    options?: ToolEmitOptions,
  ): void {
    this.ensureToolUseData(toolUseId, toolName, input, options);
  }

  private ensureToolUseData(
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
    options?: ToolEmitOptions,
    completedOnly = false,
  ): void {
    if (!this.emittedToolUseIds.has(toolUseId)) {
      if (completedOnly) {
        this.emitToolUseTracked(toolUseId, toolName, input, options);
      } else {
        this.emitToolUseStart(toolUseId, toolName, input, options);
      }
      return;
    }

    const previousInput = this.emittedToolUseInputsById.get(toolUseId) || {};
    const mergedInput = this.mergeToolUseInput(previousInput, input);
    if (JSON.stringify(previousInput) === JSON.stringify(mergedInput)) return;

    this.emittedToolUseInputsById.set(toolUseId, mergedInput);
    this.emitToolUse(toolUseId, toolName, mergedInput, options);
  }

  private emitToolResultOnce(
    toolUseId: string,
    content: unknown,
    isError: boolean,
    parentToolUseId?: string | null,
  ): void {
    if (this.emittedToolResultIds.has(toolUseId)) return;
    this.emittedToolResultIds.add(toolUseId);
    this.emitToolResult(toolUseId, content, isError, parentToolUseId);
  }

  private mergeToolUseInput(
    previous: Record<string, unknown>,
    incoming: Record<string, unknown>,
  ): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...previous };
    for (const [key, value] of Object.entries(incoming)) {
      if (value == null) continue;
      if (typeof value === "string") {
        if (value.trim().length > 0 || !(key in merged)) merged[key] = value;
        continue;
      }
      if (Array.isArray(value)) {
        if (value.length > 0 || !(key in merged)) merged[key] = value;
        continue;
      }
      if (typeof value === "object") {
        const previousValue = merged[key];
        if (previousValue && typeof previousValue === "object" && !Array.isArray(previousValue)) {
          merged[key] = this.mergeToolUseInput(
            previousValue as Record<string, unknown>,
            value as Record<string, unknown>,
          );
        } else if (!(key in merged) || Object.keys(value as Record<string, unknown>).length > 0) {
          merged[key] = value;
        }
        continue;
      }
      merged[key] = value;
    }
    return merged;
  }

  private buildImageViewResultText(path: unknown): string {
    return typeof path === "string" && path.trim().length > 0 ? path : "Image viewed successfully.";
  }

  private makeMessageId(kind: string, sourceId?: string): string {
    if (sourceId) return `codex-${kind}-${sourceId}`;
    return `codex-${kind}-${randomUUID()}`;
  }

  private extractCommandOutputDelta(params: Record<string, unknown>): string {
    const collected: string[] = [];
    const seen = new Set<unknown>();

    const visit = (value: unknown): void => {
      if (value == null || seen.has(value)) return;
      seen.add(value);
      if (typeof value === "string") {
        collected.push(value);
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (typeof value === "object") {
        const obj = value as Record<string, unknown>;
        for (const key of ["delta", "text", "output", "stdout", "stderr", "content", "message"]) {
          if (key in obj) visit(obj[key]);
        }
      }
    };

    for (const key of ["delta", "output", "stdout", "stderr", "content"]) {
      visit(params[key]);
    }

    return collected.join("");
  }
}
