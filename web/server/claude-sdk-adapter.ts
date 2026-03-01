/**
 * Claude SDK Adapter
 *
 * Bridges between the Agent SDK's stdio transport (via @anthropic-ai/claude-agent-sdk)
 * and The Companion's BrowserIncomingMessage/BrowserOutgoingMessage types.
 *
 * This adapter eliminates the WebSocket transport entirely — no 5-minute disconnect
 * cycles, no stuck isGenerating, no lost tool results. The process either exists or
 * it doesn't. Follows the same pattern as CodexAdapter for consistency.
 */

import { randomUUID } from "node:crypto";
import type {
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  PermissionRequest,
} from "./session-types.js";
import type { RecorderManager } from "./recorder.js";

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface ClaudeSdkAdapterOptions {
  model?: string;
  cwd: string;
  permissionMode?: string;
  cliSessionId?: string;
  env?: Record<string, string | undefined>;
  claudeBinary?: string;
  recorder?: RecorderManager | null;
  /** Plugin directories to pass to Claude Code */
  pluginDirs?: string[];
}

interface SessionMeta {
  cliSessionId?: string;
  model?: string;
  tools?: string[];
  permissionMode?: string;
}

interface PendingPermission {
  resolve: (result: { behavior: "allow"; updatedInput?: Record<string, unknown> } | { behavior: "deny"; message: string }) => void;
  reject: (err: Error) => void;
  requestId: string;
  toolName: string;
}

// ─── Adapter ────────────────────────────────────────────────────────────────────

export class ClaudeSdkAdapter {
  private sessionId: string;
  private options: ClaudeSdkAdapterOptions;
  private sdkSession: any = null; // SDKSession from the Agent SDK
  private connected = false;
  private browserMessageCb: ((msg: BrowserIncomingMessage) => void) | null = null;
  private sessionMetaCb: ((meta: SessionMeta) => void) | null = null;
  private disconnectCb: (() => void) | null = null;
  private initErrorCb: ((error: string) => void) | null = null;
  private pendingPermissions = new Map<string, PendingPermission>();
  private pendingOutgoing: BrowserOutgoingMessage[] = [];

  constructor(sessionId: string, options: ClaudeSdkAdapterOptions) {
    this.sessionId = sessionId;
    this.options = options;
    // Start initialization asynchronously
    this.initialize().catch((err) => {
      console.error(`[claude-sdk-adapter] Init failed for session ${sessionId}:`, err);
      this.initErrorCb?.(err instanceof Error ? err.message : String(err));
    });
  }

  // ─── Public interface (matches CodexAdapter) ────────────────────────────────

  /** Accept a message from the browser and send it to the CLI */
  sendBrowserMessage(msg: BrowserOutgoingMessage): boolean {
    if (!this.connected || !this.sdkSession) {
      this.pendingOutgoing.push(msg);
      return false;
    }
    return this.dispatchOutgoing(msg);
  }

  onBrowserMessage(cb: (msg: BrowserIncomingMessage) => void): void {
    this.browserMessageCb = cb;
  }

  onSessionMeta(cb: (meta: SessionMeta) => void): void {
    this.sessionMetaCb = cb;
  }

  onDisconnect(cb: () => void): void {
    this.disconnectCb = cb;
  }

  onInitError(cb: (error: string) => void): void {
    this.initErrorCb = cb;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    try {
      this.sdkSession?.close();
    } catch { /* ignore */ }
    // Reject any pending permissions
    for (const [, pending] of this.pendingPermissions) {
      pending.reject(new Error("Session disconnected"));
    }
    this.pendingPermissions.clear();
  }

  // ─── Initialization ─────────────────────────────────────────────────────────

  private async initialize(): Promise<void> {
    // Dynamic import to avoid loading the SDK at startup for WebSocket-only servers
    const sdk = await import("@anthropic-ai/claude-agent-sdk");

    // Merge process.env (inherits ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN from
    // claude.sh) with session-specific vars (COMPANION_SESSION_ID, etc.)
    const mergedEnv: Record<string, string | undefined> = {
      ...process.env,
      ...(this.options.env || {}),
    };

    const sessionOptions: Record<string, unknown> = {
      cwd: this.options.cwd,
      permissionMode: this.mapPermissionMode(this.options.permissionMode),
      env: mergedEnv,
      canUseTool: this.handleCanUseTool.bind(this),
    };

    // Only pass model if explicitly specified — empty/undefined means "use default"
    // which lets the Claude Code binary resolve from settings.json (respecting
    // the user's mai-agents configuration and LiteLLM proxy routing).
    if (this.options.model) {
      sessionOptions.model = this.options.model;
    }

    // bypassPermissions mode: SDK auto-approves everything, no canUseTool needed
    if (this.options.permissionMode === "bypassPermissions") {
      delete sessionOptions.canUseTool;
    }

    // Resolve the claude binary path — use the configured binary or find it on PATH
    if (this.options.claudeBinary) {
      sessionOptions.pathToClaudeCodeExecutable = this.options.claudeBinary;
    }

    // Create or resume session
    if (this.options.cliSessionId) {
      this.sdkSession = sdk.unstable_v2_resumeSession(this.options.cliSessionId, sessionOptions as any);
    } else {
      this.sdkSession = sdk.unstable_v2_createSession(sessionOptions as any);
    }

    this.connected = true;
    console.log(`[claude-sdk-adapter] Session ${this.sessionId} initialized${this.options.cliSessionId ? " (resumed)" : ""}`);

    // Flush pending outgoing messages
    for (const msg of this.pendingOutgoing.splice(0)) {
      this.dispatchOutgoing(msg);
    }

    // Start streaming messages
    this.streamMessages().catch((err) => {
      console.error(`[claude-sdk-adapter] Stream error for session ${this.sessionId}:`, err);
      this.handleDisconnect();
    });
  }

  // ─── Message streaming ──────────────────────────────────────────────────────

  private async streamMessages(): Promise<void> {
    if (!this.sdkSession) return;

    // The V2 SDK session's stream() yields messages until a result, then returns.
    // For multi-turn sessions, we loop back and call stream() again for the next turn.
    // The session stays alive between turns — only truly disconnects when closed.
    while (this.connected && this.sdkSession) {
      try {
        for await (const msg of this.sdkSession.stream()) {
          this.handleSdkMessage(msg);
        }
        // Stream ended normally (result received) — session is still alive,
        // just waiting for the next send(). Don't disconnect.
      } catch (err) {
        if (this.connected) {
          console.error(`[claude-sdk-adapter] Stream error for session ${this.sessionId}:`, err);
          this.handleDisconnect();
          return;
        }
      }
    }
  }

  // ─── SDK Message → BrowserIncomingMessage translation ───────────────────────

  private handleSdkMessage(msg: any): void {
    if (!msg || typeof msg.type !== "string") return;

    // Record raw incoming message
    this.options.recorder?.record(
      this.sessionId, "in", JSON.stringify(msg), "cli", "claude-sdk", this.options.cwd,
    );

    switch (msg.type) {
      case "system": {
        if (msg.subtype === "init") {
          // Extract session metadata
          const meta: SessionMeta = {
            cliSessionId: msg.session_id,
            model: msg.model,
            tools: msg.tools,
            permissionMode: msg.permissionMode,
          };
          this.sessionMetaCb?.(meta);

          // Forward as session_init
          this.emitBrowserMessage({
            type: "session_init",
            session: {
              session_id: msg.session_id,
              model: msg.model,
              cwd: msg.cwd || this.options.cwd,
              tools: msg.tools || [],
              permissionMode: msg.permissionMode || "default",
              claude_code_version: msg.claude_code_version,
              mcp_servers: msg.mcp_servers || [],
              agents: msg.agents || [],
              slash_commands: msg.slash_commands || [],
              skills: msg.skills || [],
            },
          } as any);
        } else if (msg.subtype === "status") {
          this.emitBrowserMessage({
            type: "status_change",
            status: msg.status || "idle",
          } as any);
        }
        break;
      }

      case "assistant":
      case "stream_event":
      case "result":
      case "tool_progress":
      case "tool_use_summary":
      case "keep_alive":
        // These types match directly between SDK and our protocol
        this.emitBrowserMessage(msg as BrowserIncomingMessage);
        break;

      default:
        // Forward unknown types as-is — the browser can handle or ignore them
        this.emitBrowserMessage(msg as BrowserIncomingMessage);
        break;
    }
  }

  // ─── Permission bridging ────────────────────────────────────────────────────

  /** Called by the Agent SDK when a tool needs permission */
  private async handleCanUseTool(
    toolName: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; suggestions?: any[]; filePath?: string; toolUseId?: string },
  ): Promise<{ behavior: "allow"; updatedInput?: Record<string, unknown> } | { behavior: "deny"; message: string }> {
    const requestId = randomUUID();
    const toolUseId = options.toolUseId || randomUUID();

    // Create a permission request and emit it to the browser
    const permRequest: PermissionRequest = {
      request_id: requestId,
      tool_name: toolName,
      input,
      tool_use_id: toolUseId,
      timestamp: Date.now(),
      ...(options.suggestions ? { permission_suggestions: options.suggestions } : {}),
    };

    this.emitBrowserMessage({
      type: "permission_request",
      request: permRequest,
    } as any);

    // Wait for the browser to respond
    return new Promise((resolve, reject) => {
      this.pendingPermissions.set(requestId, { resolve, reject, requestId, toolName });

      // Handle abort signal
      options.signal.addEventListener("abort", () => {
        this.pendingPermissions.delete(requestId);
        reject(new Error("Permission request aborted"));
      }, { once: true });
    });
  }

  // ─── Outgoing message dispatch ──────────────────────────────────────────────

  private dispatchOutgoing(msg: BrowserOutgoingMessage): boolean {
    if (!this.sdkSession || !this.connected) return false;

    const msgType = (msg as any).type;

    switch (msgType) {
      case "user_message": {
        const content = (msg as any).content;
        if (content) {
          this.sdkSession.send(content).catch((err: Error) => {
            console.error(`[claude-sdk-adapter] Send failed for session ${this.sessionId}:`, err);
          });
        }
        return true;
      }

      case "permission_response": {
        const requestId = (msg as any).request_id;
        const behavior = (msg as any).behavior;
        const pending = this.pendingPermissions.get(requestId);
        if (pending) {
          this.pendingPermissions.delete(requestId);
          if (behavior === "allow") {
            pending.resolve({
              behavior: "allow",
              updatedInput: (msg as any).updated_input,
            });
          } else {
            pending.resolve({
              behavior: "deny",
              message: (msg as any).message || "Denied by user",
            });
          }
        }
        return true;
      }

      case "interrupt": {
        console.log(`[claude-sdk-adapter] Interrupt requested for session ${this.sessionId}`);
        return true;
      }

      case "set_permission_mode": {
        // The V2 SDK session doesn't expose setPermissionMode directly.
        // The permission mode change is handled server-side (state update +
        // browser broadcast) and doesn't need to reach the CLI for SDK sessions.
        // The canUseTool callback handles all permission decisions regardless of mode.
        console.log(`[claude-sdk-adapter] Permission mode change to "${(msg as any).mode}" for session ${this.sessionId} (server-side only)`);
        return true;
      }

      default:
        console.log(`[claude-sdk-adapter] Unhandled outgoing message type: ${msgType}`);
        return false;
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private emitBrowserMessage(msg: BrowserIncomingMessage): void {
    this.options.recorder?.record(
      this.sessionId, "out", JSON.stringify(msg), "browser", "claude-sdk", this.options.cwd,
    );
    this.browserMessageCb?.(msg);
  }

  private handleDisconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    // Reject pending permissions
    for (const [, pending] of this.pendingPermissions) {
      pending.reject(new Error("Session disconnected"));
    }
    this.pendingPermissions.clear();
    this.disconnectCb?.();
  }

  private mapPermissionMode(mode?: string): string | undefined {
    // Direct mapping — Companion modes match SDK modes exactly:
    //   "plan"              → "plan" (planning only, no tool execution)
    //   "acceptEdits"       → "acceptEdits" (auto-approve file edits)
    //   "bypassPermissions" → "bypassPermissions" (auto-approve everything)
    //   "default" / other   → "default" (canUseTool callback handles permissions)
    switch (mode) {
      case "bypassPermissions": return "bypassPermissions";
      case "acceptEdits": return "acceptEdits";
      case "plan": return "plan";
      default: return "default";
    }
  }
}
