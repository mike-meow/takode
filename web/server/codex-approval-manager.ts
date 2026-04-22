import { randomUUID } from "node:crypto";
import type { BrowserIncomingMessage, BrowserOutgoingMessage, PermissionRequest } from "./session-types.js";
import type { JsonRpcTransport } from "./codex-jsonrpc-transport.js";
import {
  formatCommandForDisplay,
  mapFileChangesForTool,
  mapFileChangesObjectForTool,
  type ToolFileChange,
} from "./codex-adapter-utils.js";

type EmitFn = (msg: BrowserIncomingMessage) => void;

type PendingDynamicToolCall = {
  jsonRpcId: number;
  callId: string;
  toolName: string;
  parentToolUseId: string | null;
  timeout: ReturnType<typeof setTimeout>;
};

export class CodexApprovalManager {
  private pendingApprovals = new Map<string, number>();
  private pendingUserInputQuestionIds = new Map<string, string[]>();
  private pendingReviewDecisions = new Set<string>();
  private pendingDynamicToolCalls = new Map<string, PendingDynamicToolCall>();

  constructor(
    private readonly transport: JsonRpcTransport,
    private readonly emit: EmitFn,
    private readonly options: { cwd?: string },
    private readonly deps: {
      resolveParentToolUseId: (params: Record<string, unknown>, itemId?: string) => string | null;
      emitToolUseTracked: (
        toolUseId: string,
        toolName: string,
        input: Record<string, unknown>,
        options?: { parentToolUseId?: string | null; timestamp?: number },
      ) => void;
      emitToolResult: (toolUseId: string, content: unknown, isError: boolean, parentToolUseId?: string | null) => void;
    },
  ) {}

  dispose(): void {
    for (const pending of this.pendingDynamicToolCalls.values()) {
      clearTimeout(pending.timeout);
    }
    this.pendingDynamicToolCalls.clear();
    this.pendingApprovals.clear();
    this.pendingReviewDecisions.clear();
    this.pendingUserInputQuestionIds.clear();
  }

  async handleOutgoingPermissionResponse(msg: {
    type: "permission_response";
    request_id: string;
    behavior: "allow" | "deny";
    updated_input?: Record<string, unknown>;
  }): Promise<void> {
    const jsonRpcId = this.pendingApprovals.get(msg.request_id);
    if (jsonRpcId === undefined) {
      console.warn(`[codex-adapter] No pending approval for request_id=${msg.request_id}`);
      return;
    }

    const pendingDynamic = this.pendingDynamicToolCalls.get(msg.request_id);
    if (pendingDynamic) {
      this.pendingDynamicToolCalls.delete(msg.request_id);
      this.pendingApprovals.delete(msg.request_id);
      clearTimeout(pendingDynamic.timeout);

      const result = this.buildDynamicToolCallResponse(msg, pendingDynamic.toolName);
      await this.transport.respond(jsonRpcId, result);
      return;
    }

    this.pendingApprovals.delete(msg.request_id);

    const questionIds = this.pendingUserInputQuestionIds.get(msg.request_id);
    if (questionIds) {
      this.pendingUserInputQuestionIds.delete(msg.request_id);

      if (msg.behavior === "deny") {
        await this.transport.respond(jsonRpcId, { answers: {} });
        return;
      }

      const browserAnswers = (msg.updated_input?.answers as Record<string, string>) || {};
      const codexAnswers: Record<string, { answers: string[] }> = {};
      for (let i = 0; i < questionIds.length; i++) {
        const answer = browserAnswers[String(i)];
        if (answer !== undefined) {
          codexAnswers[questionIds[i]] = { answers: [answer] };
        }
      }

      await this.transport.respond(jsonRpcId, { answers: codexAnswers });
      return;
    }

    if (this.pendingReviewDecisions.has(msg.request_id)) {
      this.pendingReviewDecisions.delete(msg.request_id);
      const decision = msg.behavior === "allow" ? "approved" : "denied";
      await this.transport.respond(jsonRpcId, { decision });
      return;
    }

    const decision = msg.behavior === "allow" ? "accept" : "decline";
    await this.transport.respond(jsonRpcId, { decision });
  }

  handleRequest(method: string, id: number, params: Record<string, unknown>): void {
    try {
      switch (method) {
        case "item/commandExecution/requestApproval":
          this.handleCommandApproval(id, params);
          break;
        case "item/fileChange/requestApproval":
          this.handleFileChangeApproval(id, params);
          break;
        case "item/mcpToolCall/requestApproval":
          this.handleMcpToolCallApproval(id, params);
          break;
        case "item/tool/call":
          this.handleDynamicToolCall(id, params);
          break;
        case "item/tool/requestUserInput":
          this.handleUserInputRequest(id, params);
          break;
        case "applyPatchApproval":
          this.handleApplyPatchApproval(id, params);
          break;
        case "execCommandApproval":
          this.handleExecCommandApproval(id, params);
          break;
        case "account/chatgptAuthTokens/refresh":
          console.warn("[codex-adapter] Auth token refresh not supported");
          void this.transport.respond(id, { error: "not supported" });
          break;
        default:
          void this.transport.respond(id, { decision: "accept" });
          break;
      }
    } catch (err) {
      console.error(`[codex-adapter] Error handling request ${method}:`, err);
    }
  }

  private handleCommandApproval(jsonRpcId: number, params: Record<string, unknown>): void {
    const requestId = `codex-approval-${randomUUID()}`;
    this.pendingApprovals.set(requestId, jsonRpcId);

    const command = params.command as string | string[] | undefined;
    const parsedCmd = params.parsedCmd as string | undefined;
    const commandStr =
      typeof parsedCmd === "string" && parsedCmd.trim()
        ? parsedCmd
        : formatCommandForDisplay(command, params.commandActions);

    const perm: PermissionRequest = {
      request_id: requestId,
      tool_name: "Bash",
      input: {
        command: commandStr,
        cwd: (params.cwd as string) || this.options.cwd || "",
      },
      description: (params.reason as string) || `Execute: ${commandStr}`,
      tool_use_id: (params.itemId as string) || requestId,
      timestamp: Date.now(),
    };

    this.emit({ type: "permission_request", request: perm });
  }

  private handleFileChangeApproval(jsonRpcId: number, params: Record<string, unknown>): void {
    const requestId = `codex-approval-${randomUUID()}`;
    this.pendingApprovals.set(requestId, jsonRpcId);

    const rawChanges = Array.isArray(params.changes) ? (params.changes as Array<Record<string, unknown>>) : [];
    const changes = mapFileChangesForTool(rawChanges);
    const filePaths = changes.map((c) => c.path).filter(Boolean);
    const fileList = filePaths.length > 0 ? filePaths.join(", ") : undefined;

    const perm: PermissionRequest = {
      request_id: requestId,
      tool_name: "Edit",
      input: {
        description: (params.reason as string) || "File changes pending approval",
        ...(filePaths[0] ? { file_path: filePaths[0] } : {}),
        ...(filePaths.length > 0 && { file_paths: filePaths }),
        ...(changes.length > 0 && { changes }),
      },
      description:
        (params.reason as string) || (fileList ? `Codex wants to modify: ${fileList}` : "Codex wants to modify files"),
      tool_use_id: (params.itemId as string) || requestId,
      timestamp: Date.now(),
    };

    this.emit({ type: "permission_request", request: perm });
  }

  private handleMcpToolCallApproval(jsonRpcId: number, params: Record<string, unknown>): void {
    const requestId = `codex-approval-${randomUUID()}`;
    this.pendingApprovals.set(requestId, jsonRpcId);

    const server = (params.server as string) || "unknown";
    const tool = (params.tool as string) || "unknown";
    const args = (params.arguments as Record<string, unknown>) || {};

    const perm: PermissionRequest = {
      request_id: requestId,
      tool_name: `mcp:${server}:${tool}`,
      input: args,
      description: (params.reason as string) || `MCP tool call: ${server}/${tool}`,
      tool_use_id: (params.itemId as string) || requestId,
      timestamp: Date.now(),
    };

    this.emit({ type: "permission_request", request: perm });
  }

  private handleDynamicToolCall(jsonRpcId: number, params: Record<string, unknown>): void {
    const callId = (params.callId as string) || `dynamic-${randomUUID()}`;
    const toolName = (params.tool as string) || "unknown_dynamic_tool";
    const toolArgs = (params.arguments as Record<string, unknown>) || {};
    const requestId = `codex-dynamic-${randomUUID()}`;
    const parentToolUseId = this.deps.resolveParentToolUseId(params, callId);

    this.deps.emitToolUseTracked(callId, `dynamic:${toolName}`, toolArgs, { parentToolUseId });

    this.pendingApprovals.set(requestId, jsonRpcId);
    const timeout = setTimeout(() => {
      void this.resolveDynamicToolCallTimeout(requestId);
    }, 120_000);

    this.pendingDynamicToolCalls.set(requestId, {
      jsonRpcId,
      callId,
      toolName,
      parentToolUseId,
      timeout,
    });

    const perm: PermissionRequest = {
      request_id: requestId,
      tool_name: `dynamic:${toolName}`,
      input: {
        ...toolArgs,
        call_id: callId,
      },
      description: `Custom tool call: ${toolName}`,
      tool_use_id: callId,
      timestamp: Date.now(),
    };

    this.emit({ type: "permission_request", request: perm });
  }

  private async resolveDynamicToolCallTimeout(requestId: string): Promise<void> {
    const pending = this.pendingDynamicToolCalls.get(requestId);
    if (!pending) return;

    this.pendingDynamicToolCalls.delete(requestId);
    this.pendingApprovals.delete(requestId);

    this.deps.emitToolResult(
      pending.callId,
      `Dynamic tool "${pending.toolName}" timed out waiting for output.`,
      true,
      pending.parentToolUseId,
    );

    try {
      await this.transport.respond(pending.jsonRpcId, {
        contentItems: [{ type: "inputText", text: `Timed out waiting for dynamic tool output: ${pending.toolName}` }],
        success: false,
      });
    } catch (err) {
      console.warn(`[codex-adapter] Failed to send dynamic tool timeout response: ${err}`);
    }
  }

  private buildDynamicToolCallResponse(
    msg: { behavior: "allow" | "deny"; updated_input?: Record<string, unknown> },
    toolName: string,
  ): { contentItems: unknown[]; success: boolean; structuredContent?: unknown } {
    if (msg.behavior === "deny") {
      return {
        contentItems: [{ type: "inputText", text: `Dynamic tool "${toolName}" was denied by user` }],
        success: false,
      };
    }

    const rawContentItems = msg.updated_input?.contentItems;
    const contentItems =
      Array.isArray(rawContentItems) && rawContentItems.length > 0
        ? rawContentItems
        : [{ type: "inputText", text: String(msg.updated_input?.text || "Dynamic tool call completed") }];

    const success = typeof msg.updated_input?.success === "boolean" ? msg.updated_input.success : true;
    const structuredContent = msg.updated_input?.structuredContent;

    return {
      contentItems,
      success,
      ...(structuredContent !== undefined ? { structuredContent } : {}),
    };
  }

  private handleUserInputRequest(jsonRpcId: number, params: Record<string, unknown>): void {
    const requestId = `codex-userinput-${randomUUID()}`;
    this.pendingApprovals.set(requestId, jsonRpcId);

    const questions =
      (params.questions as Array<{
        id: string;
        header: string;
        question: string;
        options: Array<{ label: string; description: string }> | null;
      }>) || [];

    this.pendingUserInputQuestionIds.set(
      requestId,
      questions.map((q) => q.id),
    );

    const perm: PermissionRequest = {
      request_id: requestId,
      tool_name: "AskUserQuestion",
      input: {
        questions: questions.map((q) => ({
          header: q.header,
          question: q.question,
          options: q.options?.map((o) => ({ label: o.label, description: o.description })) || [],
        })),
      },
      description: questions[0]?.question || "User input requested",
      tool_use_id: (params.itemId as string) || requestId,
      timestamp: Date.now(),
    };

    this.emit({ type: "permission_request", request: perm });
  }

  private handleApplyPatchApproval(jsonRpcId: number, params: Record<string, unknown>): void {
    const requestId = `codex-patch-${randomUUID()}`;
    this.pendingApprovals.set(requestId, jsonRpcId);
    this.pendingReviewDecisions.add(requestId);

    const fileChanges = (params.fileChanges as Record<string, unknown>) || {};
    const changes = mapFileChangesObjectForTool(fileChanges);
    const filePaths = changes.map((c) => c.path).filter(Boolean);
    const reason = params.reason as string | null;

    const perm: PermissionRequest = {
      request_id: requestId,
      tool_name: "Edit",
      input: {
        ...(filePaths[0] ? { file_path: filePaths[0] } : {}),
        file_paths: filePaths,
        ...(changes.length > 0 ? { changes } : {}),
        ...(reason && { reason }),
      },
      description:
        reason ||
        (filePaths.length > 0 ? `Codex wants to modify: ${filePaths.join(", ")}` : "Codex wants to modify files"),
      tool_use_id: (params.callId as string) || requestId,
      timestamp: Date.now(),
    };

    this.emit({ type: "permission_request", request: perm });
  }

  private handleExecCommandApproval(jsonRpcId: number, params: Record<string, unknown>): void {
    const requestId = `codex-exec-${randomUUID()}`;
    this.pendingApprovals.set(requestId, jsonRpcId);
    this.pendingReviewDecisions.add(requestId);

    const command = params.command as string | string[] | undefined;
    const commandStr = formatCommandForDisplay(command, params.commandActions);
    const cwd = (params.cwd as string) || this.options.cwd || "";
    const reason = params.reason as string | null;

    const perm: PermissionRequest = {
      request_id: requestId,
      tool_name: "Bash",
      input: {
        command: commandStr,
        cwd,
      },
      description: reason || `Execute: ${commandStr}`,
      tool_use_id: (params.callId as string) || requestId,
      timestamp: Date.now(),
    };

    this.emit({ type: "permission_request", request: perm });
  }
}
