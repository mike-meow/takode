/**
 * Claude SDK Adapter
 *
 * Bridges between the Agent SDK's stdio transport (via @anthropic-ai/claude-agent-sdk)
 * and The Companion's BrowserIncomingMessage/BrowserOutgoingMessage types.
 *
 * This adapter eliminates the WebSocket transport layer, which reduces a major class
 * of transport disconnect issues (e.g. periodic WS churn) and simplifies liveness
 * semantics to process lifecycle. The bridge still handles disconnect/relaunch and
 * generation-state edge cases above the adapter layer. Follows the same pattern as
 * CodexAdapter for consistency.
 */

import { randomUUID } from "node:crypto";
import { withNonInteractiveGitEditorEnv } from "./cli-launcher-env.js";
import { getEnrichedPath } from "./path-resolver.js";
import {
  formatVsCodeSelectionPrompt,
  type BrowserIncomingMessage,
  type BrowserOutgoingMessage,
  type PermissionRequest,
  type VsCodeSelectionMetadata,
} from "./session-types.js";
import type { RecorderManager } from "./recorder.js";
import { trafficStats } from "./traffic-stats.js";
import type {
  BackendAdapter,
  CompactRequestedAwareAdapter,
  PendingOutgoingAwareAdapter,
} from "./bridge/adapter-interface.js";

// ─── SDK internals cache ─────────────────────────────────────────────────────
// We cache class references after the first SDK import so we can patch prototypes
// without spawning a new probe process on every session creation.
let cachedV4Class: any = null;
let cachedQueryClass: any = null;

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface ClaudeSdkAdapterOptions {
  model?: string;
  cwd: string;
  permissionMode?: string;
  cliSessionId?: string;
  env?: Record<string, string | undefined>;
  claudeBinary?: string;
  debugFile?: string;
  recorder?: RecorderManager | null;
  /** Plugin directories to pass to Claude Code */
  pluginDirs?: string[];
  /** Companion instructions injected via appendSystemPrompt in the control init. */
  instructions?: string;
}

export interface ClaudeSdkSessionMeta {
  cliSessionId?: string;
  model?: string;
  tools?: string[];
  permissionMode?: string;
}

interface PendingPermission {
  resolve: (
    result: { behavior: "allow"; updatedInput?: Record<string, unknown> } | { behavior: "deny"; message: string },
  ) => void;
  reject: (err: Error) => void;
  requestId: string;
  toolName: string;
  /** Original tool input — used as updatedInput fallback when browser approves
   *  without providing modified input. The CLI's Zod schema requires updatedInput
   *  to be a Record matching the tool's input shape, not undefined or {}. */
  originalInput: Record<string, unknown>;
}

// ─── Adapter ────────────────────────────────────────────────────────────────────

export class ClaudeSdkAdapter
  implements BackendAdapter<ClaudeSdkSessionMeta>, PendingOutgoingAwareAdapter, CompactRequestedAwareAdapter
{
  private sessionId: string;
  private options: ClaudeSdkAdapterOptions;
  private sdkSession: any = null; // SDKSession from the Agent SDK
  private connected = false;
  private browserMessageCb: ((msg: BrowserIncomingMessage) => void) | null = null;
  private sessionMetaCb: ((meta: ClaudeSdkSessionMeta) => void) | null = null;
  private disconnectCb: (() => void) | null = null;
  private initErrorCb: ((error: string) => void) | null = null;
  private compactRequestedCb: (() => void) | null = null;
  private pendingPermissions = new Map<string, PendingPermission>();
  private pendingOutgoing: BrowserOutgoingMessage[] = [];
  /** Cached MCP servers from the last session_init, used to respond to mcp_get_status. */
  private cachedMcpServers: Array<{ name: string; status: string }> = [];

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

  onSessionMeta(cb: (meta: ClaudeSdkSessionMeta) => void): void {
    this.sessionMetaCb = cb;
  }

  onDisconnect(cb: () => void): void {
    this.disconnectCb = cb;
  }

  onInitError(cb: (error: string) => void): void {
    this.initErrorCb = cb;
  }

  onCompactRequested(cb: () => void): void {
    this.compactRequestedCb = cb;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    try {
      this.sdkSession?.close();
    } catch {
      /* ignore */
    }
    // Reject any pending permissions
    for (const [, pending] of this.pendingPermissions) {
      pending.reject(new Error("Session disconnected"));
    }
    this.pendingPermissions.clear();
  }

  drainPendingOutgoing(): BrowserOutgoingMessage[] {
    return this.pendingOutgoing.splice(0);
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
    const mergedEnv: Record<string, string | undefined> = withNonInteractiveGitEditorEnv({
      ...process.env,
      ...(this.options.env || {}),
      PATH: getEnrichedPath({ serverId: this.options.env?.COMPANION_SERVER_ID }),
    });

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

    // NOTE: Always provide canUseTool, even in bypassPermissions mode.
    // The ws-bridge permission pipeline handles mode-based auto-approval
    // (including bypassPermissions) while still routing interactive tools
    // (ExitPlanMode, AskUserQuestion) to the browser for user interaction.
    // Without canUseTool, the CLI handles permissions internally and these
    // interactive tools fail silently — the user never sees the plan
    // approval dialog or question form.

    // Resolve the claude binary path — use the configured binary or find it on PATH
    if (this.options.claudeBinary) {
      sessionOptions.pathToClaudeCodeExecutable = this.options.claudeBinary;
    }
    if (this.options.debugFile) {
      sessionOptions.debugFile = this.options.debugFile;
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
        debugFile: this.options.debugFile ?? null,
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
        // fast. We just need class references — the subprocess dying is fine.
        // This probe only runs ONCE per server process lifetime (result is cached).
        const probe = (sdk as any).unstable_v2_createSession({
          permissionMode: "bypassPermissions",
          pathToClaudeCodeExecutable: "__nonexistent_probe__",
        });
        cachedV4Class = probe?.query?.transport?.constructor ?? null;
        cachedQueryClass = probe?.query?.constructor ?? null;
        console.log(`[claude-sdk-adapter] V4 probe: v4Class=${!!cachedV4Class} queryClass=${!!cachedQueryClass}`);
        // Close the probe session immediately
        try {
          probe?.close?.();
        } catch {
          /* ignore */
        }
      } catch (probeErr) {
        // Probe failed — classes unavailable, skip the patches
        console.warn(`[claude-sdk-adapter] V4 probe failed:`, probeErr instanceof Error ? probeErr.message : probeErr);
      }
    }
    const v4Class = cachedV4Class;
    const queryClass = cachedQueryClass;

    // PATCH 1: V4 (ProcessTransport) — inject settingSources and plugins into
    // CLI args. The SDK's v2 SQ class hardcodes settingSources:[] and omits
    // plugins; we override them before the subprocess spawns.
    const originalV4Initialize = v4Class?.prototype?.initialize;
    if (v4Class && originalV4Initialize) {
      const patchedSettingSources = sessionOptions.settingSources as string[];
      const patchedPlugins = plugins;
      v4Class.prototype.initialize = function patchedV4Initialize(this: any) {
        this.options.settingSources = patchedSettingSources;
        if (patchedPlugins.length > 0) {
          this.options.plugins = patchedPlugins;
        }
        return originalV4Initialize.call(this);
      };
    } else {
      console.warn(
        `[claude-sdk-adapter] Could not patch V4.prototype.initialize — settingSources and plugins may not reach the CLI`,
      );
    }

    // PATCH 2: Query class — inject appendSystemPrompt into the initialize
    // control_request. In SDK 0.2.101+, appendSystemPrompt is sent via the
    // Query's initialize() control_request (reading from this.initConfig),
    // NOT via V4's CLI args. The v2 API (unstable_v2_createSession) doesn't
    // pass initConfig to the Query constructor, so we patch the Query's
    // initialize() to inject it before the request is built.
    const originalQueryInitialize = queryClass?.prototype?.initialize;
    if (queryClass && originalQueryInitialize && this.options.instructions) {
      const patchedAppendSystemPrompt = this.options.instructions;
      queryClass.prototype.initialize = async function patchedQueryInitialize(this: any) {
        // Ensure initConfig exists and inject appendSystemPrompt
        if (!this.initConfig) {
          this.initConfig = {};
        }
        this.initConfig.appendSystemPrompt = patchedAppendSystemPrompt;
        return originalQueryInitialize.call(this);
      };
      console.log(
        `[claude-sdk-adapter] Patching Query.initialize for session ${this.sessionId}` +
          ` (appendSystemPrompt=${patchedAppendSystemPrompt.length} chars)`,
      );
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
    // is still set to targetCwd when the subprocess spawns. The prototype patches
    // above are also active at this point.
    try {
      if (this.options.cliSessionId) {
        this.sdkSession = sdk.unstable_v2_resumeSession(this.options.cliSessionId, sessionOptions as any);
      } else {
        this.sdkSession = sdk.unstable_v2_createSession(sessionOptions as any);
      }
    } finally {
      // Restore immediately — the subprocess has already been spawned synchronously.
      if (process.cwd() !== originalCwd) {
        try {
          process.chdir(originalCwd);
        } catch {
          /* ignore */
        }
      }
      // Always restore original prototypes
      if (v4Class && originalV4Initialize) {
        v4Class.prototype.initialize = originalV4Initialize;
      }
      if (queryClass && originalQueryInitialize) {
        queryClass.prototype.initialize = originalQueryInitialize;
      }
    }

    this.connected = true;
    console.log(
      `[claude-sdk-adapter] Session ${this.sessionId} initialized${this.options.cliSessionId ? " (resumed)" : ""}`,
    );

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
        // Stream ended normally (result received) -- session is still alive,
        // just waiting for the next send(). Don't disconnect.
        console.log(`[claude-sdk-adapter] Stream turn ended for session ${this.sessionId}`);
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
    const raw = JSON.stringify(msg);
    this.options.recorder?.record(this.sessionId, "in", raw, "cli", "claude-sdk", this.options.cwd);
    trafficStats.record({
      sessionId: this.sessionId,
      channel: "cli",
      direction: "in",
      messageType: typeof msg.subtype === "string" && msg.subtype ? `${msg.type}.${msg.subtype}` : msg.type,
      payloadBytes: Buffer.byteLength(raw, "utf-8"),
    });

    switch (msg.type) {
      case "system": {
        if (msg.subtype === "init") {
          // Extract session metadata
          const meta: ClaudeSdkSessionMeta = {
            cliSessionId: msg.session_id,
            model: msg.model,
            tools: msg.tools,
            permissionMode: msg.permissionMode,
          };
          this.sessionMetaCb?.(meta);

          // Cache MCP servers for later mcp_get_status queries
          this.cachedMcpServers = msg.mcp_servers || [];

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
        } else if (msg.subtype === "task_notification") {
          // Forward background agent completion notifications so the bridge
          // can persist them and the browser can show sub-agent chip state.
          this.emitBrowserMessage({
            type: "task_notification",
            task_id: msg.task_id,
            tool_use_id: msg.tool_use_id,
            status: msg.status,
            output_file: msg.output_file,
            summary: msg.summary,
          } as any);
        } else if (msg.subtype === "compact_boundary") {
          // Forward compaction boundary markers so the bridge can track
          // compaction state for SDK sessions.
          this.emitBrowserMessage(msg as BrowserIncomingMessage);
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

    // Wait for the browser/server to respond.
    // IMPORTANT: Register the pending promise BEFORE emitting the permission
    // request. The server may auto-approve mode-based permissions (Write in
    // acceptEdits mode) synchronously within the emitBrowserMessage call chain,
    // which calls sendBrowserMessage → dispatchOutgoing → pendingPermissions.get().
    // If the promise isn't registered yet, the approval is silently dropped and
    // the tool hangs until the SDK's abort signal fires (~3.5 minutes).
    return new Promise((resolve) => {
      this.pendingPermissions.set(requestId, {
        resolve,
        reject: (err: Error) => {
          // On unexpected errors, resolve with deny (never reject — rejected promises
          // confuse the SDK's retry logic and cause the session to loop through
          // alternative approaches without permission).
          resolve({ behavior: "deny", message: err.message || "Permission request failed" });
        },
        requestId,
        toolName,
        originalInput: input,
      });

      // Handle abort signal — resolve with deny, don't reject
      options.signal.addEventListener(
        "abort",
        () => {
          this.pendingPermissions.delete(requestId);
          resolve({ behavior: "deny", message: "Permission request aborted" });
        },
        { once: true },
      );

      // Now emit the permission request — this may trigger synchronous auto-approval
      this.emitBrowserMessage({
        type: "permission_request",
        request: permRequest,
      } as any);
    });
  }

  // ─── Outgoing message dispatch ──────────────────────────────────────────────

  private dispatchOutgoing(msg: BrowserOutgoingMessage): boolean {
    if (!this.sdkSession || !this.connected) return false;

    const msgType = (msg as any).type;
    trafficStats.record({
      sessionId: this.sessionId,
      channel: "cli",
      direction: "out",
      messageType: typeof msgType === "string" && msgType ? msgType : "unknown",
      payloadBytes: Buffer.byteLength(JSON.stringify(msg), "utf-8"),
    });

    switch (msgType) {
      case "user_message": {
        const content = (msg as any).content;
        const vscodeSelection = (msg as any).vscodeSelection as VsCodeSelectionMetadata | undefined;
        const selectionText = vscodeSelection ? formatVsCodeSelectionPrompt(vscodeSelection) : null;
        if (!content && !selectionText) return true;

        // /compact interception is handled by ws-bridge.routeBrowserMessage
        // before timestamp tagging. The adapter just forwards it to the CLI.
        // Raw image payloads are rejected by routeBrowserMessage's ingress
        // guard before reaching this adapter -- no image handling needed here.

        if (selectionText) {
          // No images but VSCode selection present: send as structured message
          // with content block array so the model sees both the user text and
          // the selection hint.
          const sdkMsg = {
            type: "user" as const,
            message: {
              role: "user" as const,
              content: [
                { type: "text", text: content },
                { type: "text", text: selectionText },
              ],
            },
            parent_tool_use_id: null,
            session_id: this.sessionId,
          };
          this.sdkSession.send(sdkMsg).catch((err: Error) => {
            console.error(`[claude-sdk-adapter] Send failed for session ${this.sessionId}:`, err);
          });
        } else {
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
            // Always provide updatedInput — the CLI's Zod schema requires a Record,
            // not undefined. Use browser-provided input if non-empty, otherwise fall
            // back to the original tool input from the permission request.
            pending.resolve({
              behavior: "allow",
              updatedInput: updatedInput && Object.keys(updatedInput).length > 0 ? updatedInput : pending.originalInput,
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
        // SDK sessions use --permission-prompt-tool stdio, so ALL tool permission
        // decisions go through the canUseTool callback — the CLI's internal mode
        // is irrelevant. Mode-based auto-approval is handled server-side in
        // ws-bridge's handleSdkPermissionRequest().
        //
        // DO NOT send setPermissionMode to the CLI subprocess — it corrupts the
        // SDK's stdin/stdout stream, breaking subsequent tool calls with
        // "Stream closed" errors.
        console.log(
          `[claude-sdk-adapter] Permission mode change to "${(msg as any).mode}" for session ${this.sessionId} (server-side only)`,
        );
        return true;
      }

      case "set_model": {
        // Forward model change to the CLI subprocess via the internal v1 Query.
        // Unlike permission mode, the model must reach the CLI so it uses the
        // correct model for the next API call.
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

      case "mcp_get_status": {
        // The Claude Code SDK doesn't expose runtime MCP status queries.
        // Return the cached server list from the last session_init -- this
        // gives the browser the same data it received on connect, which is
        // sufficient for UI display.
        const servers = this.cachedMcpServers.map((s) => ({
          name: s.name,
          status: s.status as "connected" | "failed" | "disabled" | "connecting",
          config: { type: "unknown" },
          scope: "user",
        }));
        this.emitBrowserMessage({ type: "mcp_status", servers } as any);
        return true;
      }

      default:
        console.log(`[claude-sdk-adapter] Unhandled outgoing message type: ${msgType}`);
        return false;
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private emitBrowserMessage(msg: BrowserIncomingMessage): void {
    // Don't record here — the bridge's broadcastToBrowsers records the
    // sequenced message after assigning a seq number. Recording in both
    // places doubles every entry in the recording file (one without seq
    // from here, one with seq from the bridge).
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
      case "bypassPermissions":
        return "bypassPermissions";
      case "acceptEdits":
        return "acceptEdits";
      case "plan":
        return "plan";
      default:
        return "default";
    }
  }
}
