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
import { getEnrichedPath } from "./path-resolver.js";
import type {
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  PermissionRequest,
} from "./session-types.js";
import type { RecorderManager } from "./recorder.js";

// ─── SDK internals cache ─────────────────────────────────────────────────────
// We cache the V4 (ProcessTransport) class reference after the first SDK import
// so we can patch V4.prototype.initialize without spawning a new probe process
// on every session creation.
let cachedV4Class: any = null;

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

    // Build the plugins list from pluginDirs
    const plugins = (this.options.pluginDirs ?? []).map((path) => ({ type: "local" as const, path }));

    const sessionOptions: Record<string, unknown> = {
      cwd: this.options.cwd,
      permissionMode: this.mapPermissionMode(this.options.permissionMode),
      env: mergedEnv,
      canUseTool: this.handleCanUseTool.bind(this),
      // NOTE: settingSources and plugins are NOT forwarded by the v2 SDK's SQ
      // class to the underlying V4 (ProcessTransport). SQ hardcodes
      // settingSources:[] and omits plugins entirely. We work around this by
      // patching V4.prototype.initialize (see below) so the subprocess receives
      // the correct --setting-sources and --plugin-dir flags.
      settingSources: ["user", "project", "local"],
      ...(plugins.length > 0 ? { plugins } : {}),
    };

    // Pass model explicitly if provided — otherwise the CLI reads it from
    // settings.json (which we load via settingSources).
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

    console.log(
      `[claude-sdk-adapter] Creating session ${this.sessionId} with options:`,
      JSON.stringify({
        cwd: this.options.cwd,
        permissionMode: sessionOptions.permissionMode,
        model: sessionOptions.model ?? "(from settings.json)",
        settingSources: sessionOptions.settingSources,
        plugins: plugins.map((p) => p.path),
        claudeBinary: this.options.claudeBinary ?? "(default)",
      }),
    );

    // WORKAROUND: The SDK's v2 SQ class hardcodes settingSources:[] and omits
    // plugins when constructing V4 (ProcessTransport). We fix this by temporarily
    // patching V4.prototype.initialize to inject the correct values before the
    // subprocess spawns.
    //
    // Strategy:
    //  1. On first call, create a throwaway SQ instance with a nonexistent binary
    //     to get the V4 class reference (cached module-level for subsequent calls).
    //  2. Save the original V4.prototype.initialize.
    //  3. Replace it with a wrapper that overrides settingSources and plugins in
    //     this.options before delegating to the original.
    //  4. Create the real session (which synchronously calls new V4 → V4.initialize).
    //  5. Restore the original prototype method immediately after.
    //
    // Safety: JavaScript is single-threaded — no concurrent code can call
    // V4.prototype.initialize between step 3 and step 5.
    if (!cachedV4Class) {
      try {
        // Probe: create a session with a nonexistent binary so the process fails
        // fast. We just need the V4 class reference — the subprocess dying is fine.
        // This probe only runs ONCE per server process lifetime (result is cached).
        const probe = (sdk as any).unstable_v2_createSession({
          permissionMode: "bypassPermissions",
          pathToClaudeCodeExecutable: "__nonexistent_probe__",
        });
        cachedV4Class = probe?.query?.transport?.constructor ?? null;
        // Close the probe session immediately
        try { probe?.close?.(); } catch { /* ignore */ }
      } catch {
        // Probe failed — V4 class unavailable, skip the patch
      }
    }
    const v4Class = cachedV4Class;

    const originalInitialize = v4Class?.prototype?.initialize;
    if (v4Class && originalInitialize) {
      const patchedSettingSources = sessionOptions.settingSources as string[];
      const patchedPlugins = plugins;
      v4Class.prototype.initialize = function patchedInitialize(this: any) {
        // Override the values SQ hardcoded so V4 builds correct CLI args
        this.options.settingSources = patchedSettingSources;
        if (patchedPlugins.length > 0) {
          this.options.plugins = patchedPlugins;
        }
        return originalInitialize.call(this);
      };
    } else {
      console.warn(`[claude-sdk-adapter] Could not patch V4.prototype.initialize — settingSources and plugins may not reach the CLI`);
    }

    // WORKAROUND: The SDK's v2 session API (SDKSessionOptions) does NOT expose
    // `cwd` — the Session constructor (SQ) never forwards it to ProcessTransport
    // (V4). So the subprocess inherits process.cwd().
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
    // is still set to targetCwd when the subprocess spawns. The V4.prototype.initialize
    // patch above is also active at this point.
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
      // Always restore the original V4.prototype.initialize
      if (v4Class && originalInitialize) {
        v4Class.prototype.initialize = originalInitialize;
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
        // The v2 SDKSession type doesn't expose interrupt() directly, but the
        // underlying SQ class holds a v1 Query at this.query which has it.
        // Calling query.interrupt() sends a control_request {subtype:"interrupt"}
        // to the CLI process — the same mechanism the Stop button uses for
        // WebSocket sessions.
        const query = (this.sdkSession as any)?.query;
        if (query?.interrupt) {
          query.interrupt().catch((err: Error) => {
            console.error(`[claude-sdk-adapter] Interrupt failed for session ${this.sessionId}:`, err);
          });
          console.log(`[claude-sdk-adapter] Interrupt sent for session ${this.sessionId}`);
        } else {
          console.warn(`[claude-sdk-adapter] No interrupt method available for session ${this.sessionId}`);
        }
        return true;
      }

      case "set_permission_mode": {
        // Forward the mode change to the CLI subprocess via the internal v1 Query.
        // The v2 SDKSession doesn't expose setPermissionMode(), but the underlying
        // Query (U4) does — same pattern as interrupt().
        // Without this, the CLI subprocess stays in its original mode (e.g. "plan")
        // even after ExitPlanMode approval, causing spurious permission prompts.
        const newMode = (msg as any).mode;
        const query = (this.sdkSession as any)?.query;
        if (query?.setPermissionMode) {
          query.setPermissionMode(newMode).catch((err: Error) => {
            console.error(`[claude-sdk-adapter] setPermissionMode failed for session ${this.sessionId}:`, err);
          });
          console.log(`[claude-sdk-adapter] Permission mode changed to "${newMode}" for session ${this.sessionId}`);
        } else {
          console.warn(`[claude-sdk-adapter] No setPermissionMode method available for session ${this.sessionId} — mode "${newMode}" is server-side only`);
        }
        return true;
      }

      case "set_model": {
        // Forward model change to the CLI subprocess via the internal v1 Query.
        const model = (msg as any).model;
        const queryForModel = (this.sdkSession as any)?.query;
        if (queryForModel?.setModel) {
          queryForModel.setModel(model).catch((err: Error) => {
            console.error(`[claude-sdk-adapter] setModel failed for session ${this.sessionId}:`, err);
          });
          console.log(`[claude-sdk-adapter] Model changed to "${model}" for session ${this.sessionId}`);
        } else {
          console.warn(`[claude-sdk-adapter] No setModel method available for session ${this.sessionId}`);
        }
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
