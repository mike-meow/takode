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
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { getEnrichedPath } from "./path-resolver.js";
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
    // Enrich PATH so the SDK can find the `claude` binary and companion skills
    // (e.g., quest CLI in ~/.companion/bin). Without this, SDK sessions can't
    // find binaries that aren't on the default system PATH.
    const mergedEnv: Record<string, string | undefined> = {
      ...process.env,
      ...(this.options.env || {}),
      PATH: getEnrichedPath(),
    };

    const sessionOptions: Record<string, unknown> = {
      cwd: this.options.cwd,
      permissionMode: this.mapPermissionMode(this.options.permissionMode),
      env: mergedEnv,
      canUseTool: this.handleCanUseTool.bind(this),
    };

    // Resolve model: if not explicitly specified, read from Claude Code's
    // settings.json. The SDK doesn't read settings.json itself (unlike the CLI),
    // so we must pass the model explicitly or it defaults to Sonnet.
    let resolvedModel = this.options.model;
    if (!resolvedModel) {
      resolvedModel = await this.readModelFromSettings();
    }
    if (resolvedModel) {
      sessionOptions.model = resolvedModel;
    }

    // bypassPermissions mode: SDK auto-approves everything, no canUseTool needed
    if (this.options.permissionMode === "bypassPermissions") {
      delete sessionOptions.canUseTool;
    }

    // Resolve the claude binary path — use the configured binary or find it on PATH
    if (this.options.claudeBinary) {
      sessionOptions.pathToClaudeCodeExecutable = this.options.claudeBinary;
    }

    // WORKAROUND: The SDK's v2 session API hardcodes settingSources: [] which
    // passes --setting-sources "" to the CLI, disabling all settings loading
    // (including CLAUDE.md). We inject CLAUDE.md content via a SessionStart hook
    // that returns additionalContext — the SDK appends this to the system prompt.
    if (!this.options.cliSessionId) {
      // Only for fresh sessions — resumed sessions already have the context
      const claudeMdContent = await this.loadClaudeMdFiles(this.options.cwd);
      if (claudeMdContent) {
        const existingHooks = (sessionOptions.hooks as Record<string, unknown[]> | undefined) || {};
        const sessionStartHooks = (existingHooks.SessionStart as unknown[] | undefined) || [];
        sessionStartHooks.push({
          hooks: [async () => ({
            hookSpecificOutput: {
              hookEventName: "SessionStart",
              additionalContext: claudeMdContent,
            },
          })],
        });
        existingHooks.SessionStart = sessionStartHooks;
        sessionOptions.hooks = existingHooks;
      }
    }

    // WORKAROUND: The SDK's v2 session API (SDKSessionOptions) does NOT expose
    // `cwd` or `spawnClaudeCodeProcess` — those exist only on the query() API's
    // Options type. The Session constructor (SQ) never forwards them to
    // ProcessTransport (V4). So the subprocess inherits process.cwd().
    //
    // We temporarily chdir before the synchronous SDK constructor call. This is
    // safe because: (1) JavaScript is single-threaded — no other code runs
    // between chdir and restore, (2) the SDK constructor synchronously spawns
    // the subprocess (V4.initialize() is called from the constructor, not
    // deferred), (3) all await points in our initialize() happen ABOVE this
    // block, so no other async code can interleave here.
    const originalCwd = process.cwd();
    const targetCwd = this.options.cwd;
    if (targetCwd && targetCwd !== originalCwd) {
      try {
        process.chdir(targetCwd);
      } catch (e) {
        console.warn(`[claude-sdk-adapter] Failed to chdir to ${targetCwd}: ${e instanceof Error ? e.message : e}`);
      }
    }

    // Create or resume session — MUST be synchronous (no await) so process.cwd()
    // is still set to targetCwd when the subprocess spawns.
    try {
      if (this.options.cliSessionId) {
        this.sdkSession = sdk.unstable_v2_resumeSession(this.options.cliSessionId, sessionOptions as any);
      } else {
        this.sdkSession = sdk.unstable_v2_createSession(sessionOptions as any);
      }
    } finally {
      // Restore immediately — the subprocess has already been spawned synchronously.
      if (process.cwd() !== originalCwd) {
        try { process.chdir(originalCwd); } catch { /* ignore */ }
      }
    }

    this.connected = true;
    console.log(`[claude-sdk-adapter] Session ${this.sessionId} initialized${this.options.cliSessionId ? " (resumed)" : ""}`);

    // Flush pending outgoing messages
    for (const msg of this.pendingOutgoing.splice(0)) {
      this.dispatchOutgoing(msg);
    }

    // Start streaming messages
    this.streamMessages().catch((err) => {
      const errMsg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
      console.error(`[claude-sdk-adapter] Stream error for session ${this.sessionId}: ${errMsg}`);
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
          const errMsg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
          console.error(`[claude-sdk-adapter] Stream error for session ${this.sessionId}: ${errMsg}`);
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
    return new Promise((resolve) => {
      this.pendingPermissions.set(requestId, { resolve, reject: (err: Error) => {
        // On unexpected errors, resolve with deny (never reject — rejected promises
        // confuse the SDK's retry logic and cause the session to loop through
        // alternative approaches without permission).
        resolve({ behavior: "deny", message: err.message || "Permission request failed" });
      }, requestId, toolName });

      // Handle abort signal — resolve with deny, don't reject
      options.signal.addEventListener("abort", () => {
        this.pendingPermissions.delete(requestId);
        resolve({ behavior: "deny", message: "Permission request aborted" });
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
            const updatedInput = (msg as any).updated_input;
            // Only include updatedInput when the browser actually sent modified
            // input. Omitting it means "approve with original input unchanged."
            // Including an empty {} causes the CLI to persist it in the session
            // transcript, and on --resume the CLI validates it against the tool's
            // Zod schema — an empty object fails validation for tools with
            // required fields (e.g. Bash requires 'command'), crashing the session.
            const result: { behavior: "allow"; updatedInput?: Record<string, unknown> } = { behavior: "allow" };
            if (updatedInput && Object.keys(updatedInput).length > 0) {
              result.updatedInput = updatedInput;
            }
            pending.resolve(result);
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

  /** Read the model from Claude Code's ~/.claude/settings.json.
   *  Returns the model string (e.g. "opus[1m]") or undefined if not found. */
  private async readModelFromSettings(): Promise<string | undefined> {
    try {
      const settingsPath = join(homedir(), ".claude", "settings.json");
      const raw = await readFile(settingsPath, "utf-8");
      const settings = JSON.parse(raw);
      if (settings.model && typeof settings.model === "string") {
        console.log(`[claude-sdk-adapter] Resolved model from settings.json: ${settings.model}`);
        return settings.model;
      }
    } catch {
      // settings.json doesn't exist or is malformed — SDK will use its default
    }
    return undefined;
  }

  /** Read CLAUDE.md files that the CLI would normally load from settings sources.
   *  The SDK's v2 session API hardcodes settingSources: [] which disables all
   *  settings loading. We read the files ourselves and return them as a single
   *  string for injection via --append-system-prompt. */
  private async loadClaudeMdFiles(cwd: string): Promise<string | undefined> {
    const sections: string[] = [];

    // User-level: ~/.claude/CLAUDE.md
    try {
      const userPath = join(homedir(), ".claude", "CLAUDE.md");
      const content = await readFile(userPath, "utf-8");
      if (content.trim()) {
        sections.push(`# User CLAUDE.md (~/.claude/CLAUDE.md)\n\n${content.trim()}`);
      }
    } catch { /* file doesn't exist */ }

    // Project-level: <cwd>/CLAUDE.md
    try {
      const projectPath = join(cwd, "CLAUDE.md");
      const content = await readFile(projectPath, "utf-8");
      if (content.trim()) {
        sections.push(`# Project CLAUDE.md (${projectPath})\n\n${content.trim()}`);
      }
    } catch { /* file doesn't exist */ }

    // Project .claude dir: <cwd>/.claude/CLAUDE.md
    try {
      const dotClaudePath = join(cwd, ".claude", "CLAUDE.md");
      const content = await readFile(dotClaudePath, "utf-8");
      if (content.trim()) {
        sections.push(`# Project .claude/CLAUDE.md (${dotClaudePath})\n\n${content.trim()}`);
      }
    } catch { /* file doesn't exist */ }

    if (sections.length === 0) return undefined;

    console.log(`[claude-sdk-adapter] Loaded ${sections.length} CLAUDE.md file(s) for session ${this.sessionId}`);
    return sections.join("\n\n---\n\n");
  }
}
