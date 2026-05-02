/**
 * Codex App-Server Adapter
 *
 * Translates between the Codex app-server JSON-RPC protocol (stdin/stdout)
 * and The Companion's BrowserIncomingMessage/BrowserOutgoingMessage types.
 *
 * This allows the browser to be completely unaware of which backend is running —
 * it sees the same message types regardless of whether Claude Code or Codex is
 * the backend.
 */

import { randomUUID } from "node:crypto";
import type { Subprocess } from "bun";
import {
  formatVsCodeSelectionPrompt,
  type BrowserIncomingMessage,
  type BrowserOutgoingMessage,
  type CodexAppReference,
  type CodexSkillReference,
  type SessionState,
  type CLIResultMessage,
} from "./session-types.js";
import type { RecorderManager } from "./recorder.js";
import {
  extractCodexAppsPage,
  extractCodexMentionInputs,
  extractCodexSkillReferences,
  isCompactSlashCommand,
  toSafeText,
  unwrapShellWrappedCommand,
} from "./codex-adapter-utils.js";
import { CodexApprovalManager } from "./codex-approval-manager.js";
import { CodexItemEventManager } from "./codex-item-event-manager.js";
import { JsonRpcTransport, isPidAlive } from "./codex-jsonrpc-transport.js";
import { CodexMcpManager } from "./codex-mcp-manager.js";
import type {
  BackendAdapter,
  CurrentTurnIdAwareAdapter,
  RateLimitsAwareAdapter,
  TurnStartedAwareAdapter,
  TurnStartFailedAwareAdapter,
} from "./bridge/adapter-interface.js";
import { computeContextTokensUsed, computeContextUsedPercent, type TokenUsage } from "./bridge/context-usage.js";
import { getDefaultModelForBackend } from "../shared/backend-defaults.js";
import { CODEX_LOCAL_SLASH_COMMANDS } from "../shared/codex-slash-commands.js";

const TURN_START_ACK_TIMEOUT_MS = 60_000;

// ─── Adapter Options ──────────────────────────────────────────────────────────

export interface CodexAdapterOptions {
  model?: string;
  cwd?: string;
  approvalMode?: string;
  askPermission?: boolean;
  sandbox?: "workspace-write" | "danger-full-access";
  reasoningEffort?: string;
  /** If provided, resume an existing thread instead of starting a new one. */
  threadId?: string;
  /** Optional recorder for raw message capture. */
  recorder?: RecorderManager;
  /** Companion instructions injected via session-scoped Codex config before thread start/resume. */
  instructions?: string;
  /** Optional stderr/context captured by the launcher for early startup failures. */
  failureContextProvider?: () => string | null;
}

export interface CodexResumeTurnSnapshot {
  id: string;
  status: string | null;
  error: unknown;
  items: Array<Record<string, unknown>>;
}

export interface CodexResumeSnapshot {
  threadId: string;
  turnCount: number;
  turns: CodexResumeTurnSnapshot[];
  lastTurn: CodexResumeTurnSnapshot | null;
  /** Thread-level status from the resume response (e.g. "idle", "active"). */
  threadStatus?: string | null;
}

export interface CodexSessionMeta {
  cliSessionId?: string;
  model?: string;
  cwd?: string;
  resumeSnapshot?: CodexResumeSnapshot | null;
}

// ─── JSON-RPC Transport ───────────────────────────────────────────────────────

// ─── Codex Adapter ────────────────────────────────────────────────────────────

export class CodexAdapter
  implements
    BackendAdapter<CodexSessionMeta>,
    TurnStartedAwareAdapter,
    TurnStartFailedAwareAdapter,
    CurrentTurnIdAwareAdapter,
    RateLimitsAwareAdapter
{
  private transport: JsonRpcTransport;
  private proc: Subprocess;
  private sessionId: string;
  private options: CodexAdapterOptions;

  private browserMessageCb: ((msg: BrowserIncomingMessage) => void) | null = null;
  private sessionMetaCb: ((meta: CodexSessionMeta) => void) | null = null;
  private disconnectCb: (() => void) | null = null;
  private initErrorCbs = new Set<(error: string) => void>();
  private turnStartFailedCb: ((msg: BrowserOutgoingMessage) => void) | null = null;
  private turnStartedCb: ((turnId: string) => void) | null = null;
  private turnSteeredCb: ((turnId: string, pendingInputIds: string[]) => void) | null = null;
  private turnSteerFailedCb: ((pendingInputIds: string[]) => void) | null = null;

  // State
  private threadId: string | null = null;
  private currentTurnId: string | null = null;
  private suppressedTurnResultIds = new Set<string>();
  private toolRouterErrorByTurnId = new Map<string, string>();
  private connected = false;
  private initialized = false;
  private initFailed = false;
  private collaborationModeSupported = true;

  // Last few raw JSON-RPC messages for debugging unexpected disconnects
  private recentRawMessages: string[] = [];
  private static readonly RAW_MESSAGE_RING_SIZE = 5;

  private itemEventManager: CodexItemEventManager;
  private mcpManager: CodexMcpManager;

  // Resolve when the current turn ends (used by interruptAndWaitForTurnEnd)
  private turnEndResolvers: Array<() => void> = [];

  // Queue messages received before initialization completes
  private pendingOutgoing: BrowserOutgoingMessage[] = [];
  // Serialize async outgoing dispatch so permission/interrupt/user turns can't overlap.
  private outgoingDispatchChain: Promise<void> = Promise.resolve();
  // Latest known Codex skill metadata, keyed by skill name for fast `$skill` parsing.
  private skillPathByName = new Map<string, string>();

  // Pending approval requests (Codex sends these as JSON-RPC requests with an id)
  private approvalManager: CodexApprovalManager;

  // Codex account rate limits (fetched after init, updated via notification)
  private _rateLimits: {
    primary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
    secondary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
  } | null = null;
  // Codex can publish multiple limit buckets (for example, "codex" and model-specific IDs).
  // Keep the latest values per limitId and prefer the canonical "codex" bucket for UI parity
  // with the official usage page.
  private rateLimitsByLimitId = new Map<
    string,
    {
      primary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
      secondary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
    }
  >();
  private static readonly VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);

  constructor(proc: Subprocess, sessionId: string, options: CodexAdapterOptions = {}) {
    this.proc = proc;
    this.sessionId = sessionId;
    this.options = options;

    const stdout = proc.stdout;
    const stdin = proc.stdin;
    if (!stdout || !stdin || typeof stdout === "number" || typeof stdin === "number") {
      throw new Error("Codex process must have stdio pipes");
    }

    this.transport = new JsonRpcTransport(
      stdin as WritableStream<Uint8Array> | { write(data: Uint8Array): number },
      stdout as ReadableStream<Uint8Array>,
      sessionId,
      options.recorder,
      options.cwd || "",
    );
    this.itemEventManager = new CodexItemEventManager((msg) => this.emit(msg), {
      model: this.options.model,
    });
    this.mcpManager = new CodexMcpManager(this.transport, (msg) => this.emit(msg), sessionId);
    this.approvalManager = new CodexApprovalManager(
      this.transport,
      (msg) => this.emit(msg),
      { cwd: this.options.cwd },
      {
        resolveParentToolUseId: (params, itemId) => this.itemEventManager.resolveParentToolUseId(params, itemId),
        emitToolUseTracked: (toolUseId, toolName, input, options) =>
          this.itemEventManager.emitToolUseTracked(toolUseId, toolName, input, options),
        emitToolResult: (toolUseId, content, isError, parentToolUseId) =>
          this.itemEventManager.emitToolResult(toolUseId, content, isError, parentToolUseId),
      },
    );
    this.transport.onNotification((method, params) => this.handleNotification(method, params));
    this.transport.onRequest((method, id, params) => this.handleRequest(method, id, params));

    // Keep a short raw-input ring buffer for post-mortem debugging.
    this.transport.onRawIncoming((line) => {
      const truncated = line.length > 200 ? line.substring(0, 200) + "..." : line;
      this.recentRawMessages.push(truncated);
      if (this.recentRawMessages.length > CodexAdapter.RAW_MESSAGE_RING_SIZE) {
        this.recentRawMessages.shift();
      }
    });

    // Propagate transport close (stdout ends) to the adapter.
    // This fires independently of proc.exited — stdout can close while
    // the process node wrapper is still alive, leaving the adapter in a
    // stale "connected" state that rejects messages with "Transport closed".
    this.transport.onClose(() => {
      if (!this.connected) return; // already handled by proc.exited
      const pendingIds = [...this.transport.getPendingIds()];
      console.log(
        `[codex-adapter] Transport closed for session ${sessionId} ` +
          `(pid=${proc.pid}, pidAlive=${isPidAlive(proc.pid)}, closeContext=${this.transport.getCloseContext()})` +
          ` (process may still be running)` +
          `${pendingIds.length ? `, pendingRpcIds=[${pendingIds.join(",")}]` : ""}`,
      );
      if (this.recentRawMessages.length > 0) {
        console.log(
          `[codex-adapter] Last ${this.recentRawMessages.length} raw messages before close for ${sessionId}:`,
        );
        for (const msg of this.recentRawMessages) {
          console.log(`  ${msg}`);
        }
      }
      this.connected = false;
      // Wake any turn-end waiters so they don't hang after disconnect
      for (const resolve of this.turnEndResolvers.splice(0)) resolve();
      this.itemEventManager.dispose();
      this.approvalManager.dispose();
      this.disconnectCb?.();
    });

    // Monitor process exit
    proc.exited.then((exitCode) => {
      if (!this.connected) return; // already handled by transport.onClose
      console.log(
        `[codex-adapter] Process exited for session ${sessionId} ` +
          `(pid=${proc.pid}, code=${exitCode}, closeContext=${this.transport.getCloseContext()}, connected was true — transport.onClose did not fire first)`,
      );
      this.connected = false;
      for (const resolve of this.turnEndResolvers.splice(0)) resolve();
      this.itemEventManager.dispose();
      this.approvalManager.dispose();
      this.disconnectCb?.();
    });

    // Start initialization
    this.initialize();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  getRateLimits() {
    return this._rateLimits;
  }

  async refreshSkills(forceReload = false): Promise<string[]> {
    const result = await this.transport.call("skills/list", {
      ...(this.options.cwd ? { cwds: [this.options.cwd] } : {}),
      ...(forceReload ? { forceReload: true } : {}),
    });
    const skillMetadata = extractCodexSkillReferences(result, this.options.cwd);
    this.skillPathByName = new Map();
    for (const skill of skillMetadata) {
      const path = skill.path.trim();
      if (!path) continue;
      this.skillPathByName.set(skill.name, path);
      this.skillPathByName.set(skill.name.toLowerCase(), path);
    }
    const skills = skillMetadata.map((skill) => skill.name);
    const apps = await this.refreshApps(forceReload);
    this.emit({
      type: "session_update",
      session: {
        skills,
        skill_metadata: skillMetadata,
        apps,
      },
    });
    return skills;
  }

  private async refreshApps(forceRefetch = false): Promise<CodexAppReference[]> {
    if (!this.transport.isConnected()) return [];
    const apps: CodexAppReference[] = [];
    let cursor: string | null = null;

    try {
      do {
        const result = await this.transport.call("app/list", {
          ...(cursor ? { cursor } : {}),
          ...(this.threadId ? { threadId: this.threadId } : {}),
          ...(forceRefetch ? { forceRefetch: true } : {}),
        });
        const page = extractCodexAppsPage(result);
        apps.push(...page.apps);
        cursor = page.nextCursor;
      } while (cursor);
    } catch (err) {
      console.warn(`[codex-adapter] app/list failed for session ${this.sessionId}:`, err);
      return [];
    }

    const deduped = new Map(apps.map((app) => [app.id, app]));
    return [...deduped.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  sendBrowserMessage(msg: BrowserOutgoingMessage): boolean {
    // If initialization failed, reject all new messages
    if (this.initFailed) {
      return false;
    }

    // Queue messages if not yet initialized (init is async)
    if (!this.initialized || !this.threadId) {
      if (
        msg.type === "user_message" ||
        msg.type === "codex_start_pending" ||
        msg.type === "codex_steer_pending" ||
        msg.type === "permission_response" ||
        msg.type === "mcp_get_status" ||
        msg.type === "mcp_toggle" ||
        msg.type === "mcp_reconnect" ||
        msg.type === "mcp_set_servers"
      ) {
        this.pendingOutgoing.push(msg);
        return true; // accepted, will be sent after init
      }
      // Non-queueable messages are dropped if not connected
      if (!this.connected) return false;
    }

    return this.dispatchOutgoing(msg);
  }

  private dispatchOutgoing(msg: BrowserOutgoingMessage): boolean {
    switch (msg.type) {
      case "user_message":
        this.enqueueOutgoingDispatch("user_message", () => this.handleOutgoingUserMessage(msg));
        return true;
      case "codex_start_pending":
        this.enqueueOutgoingDispatch("codex_start_pending", () => this.handleOutgoingPendingBatchStart(msg));
        return true;
      case "codex_steer_pending":
        this.enqueueOutgoingDispatch("codex_steer_pending", () => this.handleOutgoingPendingBatchSteer(msg));
        return true;
      case "permission_response":
        this.enqueueOutgoingDispatch("permission_response", () => this.handleOutgoingPermissionResponse(msg));
        return true;
      case "interrupt":
        this.enqueueOutgoingDispatch("interrupt", () => this.handleOutgoingInterrupt());
        return true;
      case "set_model":
        console.warn("[codex-adapter] Runtime model switching not supported by Codex");
        return false;
      case "set_permission_mode":
        console.warn("[codex-adapter] Runtime permission mode switching not supported by Codex");
        return false;
      case "mcp_get_status":
        this.enqueueOutgoingDispatch("mcp_get_status", () => this.mcpManager.handleGetStatus());
        return true;
      case "mcp_toggle":
        this.enqueueOutgoingDispatch("mcp_toggle", () => this.mcpManager.handleToggle(msg.serverName, msg.enabled));
        return true;
      case "mcp_reconnect":
        this.enqueueOutgoingDispatch("mcp_reconnect", () => this.mcpManager.handleReconnect());
        return true;
      case "mcp_set_servers":
        this.enqueueOutgoingDispatch("mcp_set_servers", () => this.mcpManager.handleSetServers(msg.servers));
        return true;
      default:
        return false;
    }
  }

  private enqueueOutgoingDispatch(label: string, run: () => Promise<void>): void {
    this.outgoingDispatchChain = this.outgoingDispatchChain.then(run).catch((err) => {
      console.warn(`[codex-adapter] Outgoing dispatch failed (${label}) for session ${this.sessionId}:`, err);
    });
  }

  onBrowserMessage(cb: (msg: BrowserIncomingMessage) => void): void {
    this.browserMessageCb = cb;
  }

  onSessionMeta(cb: (meta: CodexSessionMeta) => void): void {
    this.sessionMetaCb = cb;
  }

  onDisconnect(cb: () => void): void {
    this.disconnectCb = cb;
  }

  onInitError(cb: (error: string) => void): void {
    this.initErrorCbs.add(cb);
  }

  onTurnStartFailed(cb: (msg: BrowserOutgoingMessage) => void): void {
    this.turnStartFailedCb = cb;
  }

  onTurnStarted(cb: (turnId: string) => void): void {
    this.turnStartedCb = cb;
  }

  onTurnSteered(cb: (turnId: string, pendingInputIds: string[]) => void): void {
    this.turnSteeredCb = cb;
  }

  onTurnSteerFailed(cb: (pendingInputIds: string[]) => void): void {
    this.turnSteerFailedCb = cb;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    try {
      this.proc.kill("SIGTERM");
      await Promise.race([this.proc.exited, new Promise((r) => setTimeout(r, 5000))]);
    } catch {}
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  getCurrentTurnId(): string | null {
    return this.currentTurnId;
  }

  async rollbackTurns(numTurns: number): Promise<void> {
    if (!this.threadId) {
      throw new Error("No Codex thread started yet");
    }
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      throw new Error(`Invalid rollback turn count: ${numTurns}`);
    }

    const activeTurnId = this.currentTurnId;
    if (activeTurnId) {
      // Revert should not surface an extra interrupted result into Takode
      // history, because the route already truncated browser history to the
      // pre-revert state before we mutate the backend thread.
      this.suppressedTurnResultIds.add(activeTurnId);
      try {
        await this.interruptAndWaitForTurnEnd();
      } catch (err) {
        this.suppressedTurnResultIds.delete(activeTurnId);
        throw err;
      }
    }

    try {
      await this.transport.call("thread/rollback", {
        threadId: this.threadId,
        numTurns,
      });
    } catch (err) {
      if (activeTurnId) {
        this.suppressedTurnResultIds.delete(activeTurnId);
      }
      throw err;
    }
  }

  private isMissingRolloutError(err: unknown): boolean {
    const message = String(err).toLowerCase();
    return message.includes("no rollout found") || message.includes("empty session file");
  }

  // ── Initialization ──────────────────────────────────────────────────────

  private async initialize(): Promise<void> {
    try {
      let resumeSnapshot: CodexResumeSnapshot | null = null;
      // Step 1: Send initialize request
      const result = (await this.transport.call("initialize", {
        clientInfo: {
          name: "thecompanion",
          title: "The Companion",
          version: "1.0.0",
        },
        capabilities: {
          experimentalApi: true,
        },
      })) as Record<string, unknown>;

      // Step 2: Send initialized notification
      await this.transport.notify("initialized", {});

      this.initialized = true;

      await this.configureDeveloperInstructions();

      // Step 3: Start or resume a thread
      if (this.options.threadId) {
        try {
          // Resume an existing thread
          const resumeResult = (await this.transport.call("thread/resume", {
            threadId: this.options.threadId,
            model: this.options.model,
            cwd: this.options.cwd,
            approvalPolicy: this.mapApprovalPolicy(this.options.approvalMode, this.options.askPermission),
            sandbox: this.options.sandbox || this.mapSandboxPolicy(this.options.approvalMode),
          })) as { thread: Record<string, unknown> & { id: string } };
          this.threadId = resumeResult.thread.id;
          resumeSnapshot = this.buildResumeSnapshot(resumeResult.thread);
          // Only set currentTurnId if the turn is truly in-progress AND the
          // thread itself isn't idle. After a CLI restart, the thread reports
          // idle but the last turn's status may still say "inProgress" — that
          // turn is stale (it was in-progress in the dead process).
          const threadIsIdle = resumeSnapshot?.threadStatus === "idle";
          this.currentTurnId =
            !threadIsIdle && resumeSnapshot?.lastTurn?.status === "inProgress" ? resumeSnapshot.lastTurn.id : null;
        } catch (err) {
          // Fresh or partially-initialized Codex threads may fail resume with
          // "no rollout found". Fall back to a fresh thread to avoid a stuck session.
          if (!this.isMissingRolloutError(err)) throw err;
          console.warn(
            `[codex-adapter] thread/resume failed for ${this.options.threadId}: ${err}. Starting a fresh thread.`,
          );
          const threadResult = (await this.transport.call("thread/start", {
            model: this.options.model,
            cwd: this.options.cwd,
            approvalPolicy: this.mapApprovalPolicy(this.options.approvalMode, this.options.askPermission),
            sandbox: this.options.sandbox || this.mapSandboxPolicy(this.options.approvalMode),
          })) as { thread: { id: string } };
          this.threadId = threadResult.thread.id;
        }
      } else {
        // Start a new thread
        const threadResult = (await this.transport.call("thread/start", {
          model: this.options.model,
          cwd: this.options.cwd,
          approvalPolicy: this.mapApprovalPolicy(this.options.approvalMode, this.options.askPermission),
          sandbox: this.options.sandbox || this.mapSandboxPolicy(this.options.approvalMode),
        })) as { thread: { id: string } };
        this.threadId = threadResult.thread.id;
      }

      this.connected = true;

      // Notify session metadata
      this.sessionMetaCb?.({
        cliSessionId: this.threadId,
        model: this.options.model,
        cwd: this.options.cwd,
        resumeSnapshot,
      });

      // Send session_init to browser
      const state: SessionState = {
        session_id: this.sessionId,
        backend_type: "codex",
        model: this.options.model || "",
        cwd: this.options.cwd || "",
        tools: [],
        permissionMode: this.options.approvalMode || "suggest",
        claude_code_version: "",
        mcp_servers: [],
        agents: [],
        slash_commands: [...CODEX_LOCAL_SLASH_COMMANDS],
        skills: [],
        skill_metadata: [],
        apps: [],
        total_cost_usd: 0,
        num_turns: 0,
        context_used_percent: 0,
        codex_retained_payload_bytes: 0,
        is_compacting: false,
        git_branch: "",
        is_worktree: false,
        is_containerized: false,
        repo_root: "",
        git_ahead: 0,
        git_behind: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
        ...(this.options.reasoningEffort ? { codex_reasoning_effort: this.options.reasoningEffort } : {}),
      };

      this.emit({ type: "session_init", session: state });

      // Fetch initial rate limits — await so the RPC completes before flushing
      // queued messages. Without this, a concurrent rateLimits write and
      // turn/start write can interleave on the shared stdin pipe.
      try {
        const rateLimitsResult = await this.transport.call("account/rateLimits/read", {});
        this.updateRateLimits(rateLimitsResult as Record<string, unknown>);
      } catch {
        /* best-effort — don't fail init if rate limits fetch errors */
      }

      // Flush any messages that were queued during initialization
      if (this.pendingOutgoing.length > 0) {
        const queued = this.pendingOutgoing.splice(0);
        for (const msg of queued) {
          this.dispatchOutgoing(msg);
        }
      }
    } catch (err) {
      const errorMsg = this.formatInitializationError(err);
      console.error(`[codex-adapter] ${errorMsg}`);
      this.initFailed = true;
      this.connected = false;
      // Discard any messages queued during the failed init attempt
      this.pendingOutgoing.length = 0;
      for (const cb of this.initErrorCbs) {
        try {
          cb(errorMsg);
        } catch (callbackErr) {
          console.error("[codex-adapter] init-error listener failed:", callbackErr);
        }
      }
    }
  }

  // ── Outgoing message handlers ───────────────────────────────────────────

  private async handleOutgoingUserMessage(msg: {
    type: "user_message";
    content: string;
    images?: { media_type: string; data: string }[];
    vscodeSelection?: import("./session-types.js").VsCodeSelectionMetadata;
  }): Promise<void> {
    // User message is the latest completed message before Codex starts reasoning.
    this.itemEventManager.markMessageFinished(Date.now());
    if (!this.threadId) {
      this.emit({ type: "error", message: "No Codex thread started yet" });
      return;
    }

    // If a turn is already in progress, interrupt it first and wait for it to
    // complete. Sending turn/start while a turn is active causes Codex to
    // error or crash (observed as sudden disconnects, especially with image
    // attachments whose large base64 payloads amplify the timing window).
    if (this.currentTurnId) {
      console.log(
        `[codex-adapter] Turn ${this.currentTurnId} already in progress for session ${this.sessionId}, interrupting before new turn`,
      );
      await this.interruptAndWaitForTurnEnd();
    }

    // VS Code selection metadata is ambient UI context, not explicit user
    // content. A plain /compact must still reach Codex's compaction endpoint
    // even when the composer attached selection metadata to the turn.
    if (isCompactSlashCommand(msg.content) && !msg.images?.length) {
      try {
        await this.transport.call("thread/compact/start", {
          threadId: this.threadId,
        });
        return;
      } catch (err) {
        const requeued = this.handleTurnStartDispatchFailure(msg);
        if (requeued && this.isTransportClosedError(err)) {
          console.warn(
            `[codex-adapter] thread/compact/start transport closed; message re-queued for session ${this.sessionId}`,
          );
          return;
        }
        this.emit({ type: "error", message: `Failed to start compaction: ${err}` });
        return;
      }
    }

    const input: Array<{
      type: string;
      name?: string;
      text?: string;
      url?: string;
      path?: string;
      text_elements?: unknown[];
    }> = [];

    // Backend delivery is text-only. Any image payload that still reaches the
    // adapter is ignored defensively; the prompt should already contain file
    // path annotations that the model can read as normal files.
    if (msg.images?.length) {
      console.warn(
        `[codex-adapter] Ignoring unexpected image payloads for session ${this.sessionId}; expected text-only attachment path annotations`,
      );
    }

    // Add text
    input.push({ type: "text", text: msg.content, text_elements: [] });
    input.push(...extractCodexMentionInputs(msg.content, this.skillPathByName));
    if (msg.vscodeSelection) {
      input.push({ type: "text", text: formatVsCodeSelectionPrompt(msg.vscodeSelection), text_elements: [] });
    }

    // Log when payload is large (images, long prompts) to help diagnose
    // transport issues — Codex reads JSON-RPC from stdin, so huge lines
    // can cause event loop blocks and process crashes.
    const estimatedChars = input.reduce(
      (sum, i) => sum + (i.name?.length || 0) + (i.url?.length || 0) + (i.path?.length || 0) + (i.text?.length || 0),
      0,
    );
    if (estimatedChars > 500_000) {
      console.warn(
        `[codex-adapter] Large turn/start payload: ~${(estimatedChars / 1024).toFixed(0)}KB for session ${this.sessionId}`,
      );
    }

    const turnStartParams: Record<string, unknown> = {
      threadId: this.threadId,
      input,
      cwd: this.options.cwd,
    };
    const collaborationMode = this.collaborationModeSupported ? this.buildCollaborationModeOverride() : null;
    if (collaborationMode) {
      turnStartParams.collaborationMode = collaborationMode;
    }

    try {
      const result = (await this.transport.call("turn/start", turnStartParams, TURN_START_ACK_TIMEOUT_MS)) as {
        turn: { id: string };
      };
      this.currentTurnId = result.turn.id;
      this.turnStartedCb?.(result.turn.id);
    } catch (err) {
      // Older Codex builds may reject collaborationMode. If so, retry once
      // without it and remember to skip it for future turns.
      if (collaborationMode && this.isCollaborationModeUnsupportedError(err)) {
        this.collaborationModeSupported = false;
        delete turnStartParams.collaborationMode;
        console.warn(`[codex-adapter] collaborationMode not supported; falling back for session ${this.sessionId}`);
        try {
          const retry = (await this.transport.call("turn/start", turnStartParams, TURN_START_ACK_TIMEOUT_MS)) as {
            turn: { id: string };
          };
          this.currentTurnId = retry.turn.id;
          this.turnStartedCb?.(retry.turn.id);
          return;
        } catch (retryErr) {
          const requeued = this.handleTurnStartDispatchFailure(msg);
          if (requeued && this.isRecoverableTurnStartError(retryErr)) {
            console.warn(
              `[codex-adapter] turn/start did not acknowledge; message re-queued for session ${this.sessionId}: ${retryErr}`,
            );
            return;
          }
          this.emit({ type: "error", message: `Failed to start turn: ${retryErr}` });
          return;
        }
      }

      const requeued = this.handleTurnStartDispatchFailure(msg);
      if (requeued && this.isRecoverableTurnStartError(err)) {
        console.warn(
          `[codex-adapter] turn/start did not acknowledge; message re-queued for session ${this.sessionId}: ${err}`,
        );
        return;
      }
      this.emit({ type: "error", message: `Failed to start turn: ${err}` });
    }
  }

  private buildCodexBatchInput(
    entries: Array<{
      content: string;
      vscodeSelection?: import("./session-types.js").VsCodeSelectionMetadata;
    }>,
  ): Array<{ type: string; text?: string; path?: string; text_elements?: unknown[] }> {
    const input: Array<{ type: string; text?: string; path?: string; text_elements?: unknown[] }> = [];
    for (const entry of entries) {
      input.push({ type: "text", text: entry.content, text_elements: [] });
      if (entry.vscodeSelection) {
        input.push({ type: "text", text: formatVsCodeSelectionPrompt(entry.vscodeSelection), text_elements: [] });
      }
    }
    return input;
  }

  private async handleOutgoingPendingBatchStart(msg: {
    type: "codex_start_pending";
    pendingInputIds: string[];
    inputs: Array<{
      content: string;
      vscodeSelection?: import("./session-types.js").VsCodeSelectionMetadata;
    }>;
  }): Promise<void> {
    if (!this.threadId) {
      this.emit({ type: "error", message: "No Codex thread started yet" });
      return;
    }
    if (this.currentTurnId) {
      console.log(
        `[codex-adapter] Turn ${this.currentTurnId} already in progress for session ${this.sessionId}, interrupting before pending batch start`,
      );
      await this.interruptAndWaitForTurnEnd();
    }

    const input = this.buildCodexBatchInput(msg.inputs);
    const turnStartParams: Record<string, unknown> = {
      threadId: this.threadId,
      input,
      cwd: this.options.cwd,
    };
    const collaborationMode = this.collaborationModeSupported ? this.buildCollaborationModeOverride() : null;
    if (collaborationMode) turnStartParams.collaborationMode = collaborationMode;

    try {
      const result = (await this.transport.call("turn/start", turnStartParams, TURN_START_ACK_TIMEOUT_MS)) as {
        turn: { id: string };
      };
      this.currentTurnId = result.turn.id;
      this.turnStartedCb?.(result.turn.id);
    } catch (err) {
      if (collaborationMode && this.isCollaborationModeUnsupportedError(err)) {
        this.collaborationModeSupported = false;
        delete turnStartParams.collaborationMode;
        try {
          const retry = (await this.transport.call("turn/start", turnStartParams, TURN_START_ACK_TIMEOUT_MS)) as {
            turn: { id: string };
          };
          this.currentTurnId = retry.turn.id;
          this.turnStartedCb?.(retry.turn.id);
          return;
        } catch (retryErr) {
          const requeued = this.handleTurnStartDispatchFailure(msg);
          if (requeued && this.isRecoverableTurnStartError(retryErr)) return;
          this.emit({ type: "error", message: `Failed to start pending Codex batch: ${retryErr}` });
          return;
        }
      }
      const requeued = this.handleTurnStartDispatchFailure(msg);
      if (requeued && this.isRecoverableTurnStartError(err)) return;
      this.emit({ type: "error", message: `Failed to start pending Codex batch: ${err}` });
    }
  }

  private async handleOutgoingPendingBatchSteer(msg: {
    type: "codex_steer_pending";
    pendingInputIds: string[];
    expectedTurnId: string;
    inputs: Array<{
      content: string;
      vscodeSelection?: import("./session-types.js").VsCodeSelectionMetadata;
    }>;
  }): Promise<void> {
    if (!this.threadId) {
      this.emit({ type: "error", message: "No Codex thread started yet" });
      return;
    }
    const input = this.buildCodexBatchInput(msg.inputs);
    try {
      const result = (await this.transport.call("turn/steer", {
        threadId: this.threadId,
        input,
        expectedTurnId: msg.expectedTurnId,
      })) as { turnId: string };
      this.turnSteeredCb?.(result.turnId, msg.pendingInputIds);
    } catch (err) {
      this.turnSteerFailedCb?.(msg.pendingInputIds);
      this.emit({ type: "error", message: `Failed to steer active Codex turn: ${err}` });
    }
  }

  private async handleOutgoingPermissionResponse(msg: {
    type: "permission_response";
    request_id: string;
    behavior: "allow" | "deny";
    updated_input?: Record<string, unknown>;
  }): Promise<void> {
    await this.approvalManager.handleOutgoingPermissionResponse(msg);
  }

  private async handleOutgoingInterrupt(): Promise<void> {
    if (!this.threadId || !this.currentTurnId) return;

    try {
      await this.transport.call("turn/interrupt", {
        threadId: this.threadId,
        turnId: this.currentTurnId,
      });
    } catch (err) {
      console.warn("[codex-adapter] Interrupt failed:", err);
    }
  }

  /**
   * Interrupt the current turn and wait for it to end (turn/completed
   * notification clears `currentTurnId`). Times out after 5s to avoid
   * hanging indefinitely if Codex never sends turn/completed.
   */
  private async interruptAndWaitForTurnEnd(): Promise<void> {
    await this.handleOutgoingInterrupt();

    if (!this.currentTurnId) return; // Already cleared

    const TIMEOUT_MS = 5_000;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        // Remove this resolver so handleTurnCompleted doesn't call stale fn
        const idx = this.turnEndResolvers.indexOf(onEnd);
        if (idx >= 0) this.turnEndResolvers.splice(idx, 1);
        if (this.currentTurnId) {
          console.warn(
            `[codex-adapter] Turn ${this.currentTurnId} did not complete within ${TIMEOUT_MS}ms after interrupt for session ${this.sessionId}, proceeding anyway`,
          );
          this.currentTurnId = null;
        }
        resolve();
      }, TIMEOUT_MS);

      const onEnd = () => {
        clearTimeout(timer);
        resolve();
      };
      this.turnEndResolvers.push(onEnd);
    });
  }

  // ── Incoming notification handlers ──────────────────────────────────────

  private handleNotification(method: string, params: Record<string, unknown>): void {
    // Verbose per-notification logging removed — use protocol recordings for debugging.

    try {
      switch (method) {
        case "item/started":
          this.itemEventManager.handleItemStarted(params);
          break;
        case "codex/event/patch_apply_begin":
        case "codex/event/patch_apply_end":
          this.itemEventManager.cachePatchApplyChanges(params);
          break;
        case "item/agentMessage/delta":
          this.itemEventManager.handleAgentMessageDelta(params);
          break;
        case "item/commandExecution/outputDelta":
          // Streaming command output — emit as tool_progress so the browser
          // can render live elapsed time and incremental terminal output.
          this.itemEventManager.emitCommandProgress(params);
          break;
        case "item/commandExecution/terminalInteraction":
          this.itemEventManager.handleTerminalInteraction(params);
          break;
        case "item/fileChange/outputDelta":
          // Streaming file change output. Same as above.
          break;
        case "item/reasoning/textDelta":
        case "item/reasoning/summaryTextDelta":
        case "item/reasoning/summaryPartAdded":
          this.itemEventManager.handleReasoningDelta(params);
          break;
        case "item/mcpToolCall/progress": {
          // MCP tool call progress — map to tool_progress
          const itemId = params.itemId as string | undefined;
          const threadId = params.threadId as string | undefined;
          if (itemId) {
            this.emit({
              type: "tool_progress",
              tool_use_id: itemId,
              tool_name: "mcp_tool_call",
              elapsed_time_seconds: 0,
            });
          }
          break;
        }
        case "item/plan/delta":
          this.itemEventManager.emitPlanTodoWrite(params, "item_plan_delta");
          break;
        case "item/updated":
          this.itemEventManager.handleItemUpdated(params);
          break;
        case "item/completed":
          this.itemEventManager.handleItemCompleted(params);
          break;
        case "rawResponseItem/completed":
          this.itemEventManager.handleRawResponseItemCompleted(params);
          break;
        case "turn/started":
          // Turn started, nothing to emit
          break;
        case "turn/completed":
          this.handleTurnCompleted(params);
          break;
        case "turn/plan/updated":
          this.itemEventManager.emitPlanTodoWrite(params, "turn_plan_updated");
          break;
        case "codex/event/task_complete":
          this.itemEventManager.handleSubagentTaskComplete(params);
          break;
        case "turn/diff/updated":
          // Could show diff, but not needed for MVP
          break;
        case "thread/started":
          // Thread started after init — nothing to emit.
          break;
        case "thread/status/changed":
          this.handleThreadStatusChanged(params);
          break;
        case "thread/tokenUsage/updated":
          this.handleTokenUsageUpdated(params);
          break;
        case "account/updated":
        case "account/login/completed":
          // Auth events
          break;
        case "account/rateLimits/updated":
          this.updateRateLimits(params);
          break;
        case "skills/changed":
          this.refreshSkills(true).catch((err) => {
            console.warn(`[codex-adapter] Failed to refresh skills after skills/changed:`, err);
          });
          break;
        case "app/list/updated":
          this.emit({
            type: "session_update",
            session: {
              apps: extractCodexAppsPage(params).apps,
            },
          });
          break;
        case "mcpServer/startupStatus/updated":
          this.mcpManager.handleStartupStatusUpdated(params);
          break;
        case "codex/event/stream_error": {
          const msg = params.msg as { message?: string } | undefined;
          if (msg?.message) {
            console.log(`[codex-adapter] Stream error: ${msg.message}`);
          }
          break;
        }
        case "codex/event/error": {
          const msg = params.msg as { message?: string } | undefined;
          if (msg?.message) {
            console.error(`[codex-adapter] Codex error: ${msg.message}`);
            const isToolRouterFailure = this.isToolRouterFailureMessage(msg.message);
            const renderedAsToolResult = isToolRouterFailure
              ? this.itemEventManager.handleToolRouterError(msg.message)
              : false;
            if (this.currentTurnId && isToolRouterFailure) {
              this.toolRouterErrorByTurnId.set(this.currentTurnId, msg.message);
            }
            if (!renderedAsToolResult) {
              this.emit({ type: "error", message: msg.message });
            }
          }
          break;
        }
        default:
          // Unknown notification, log for debugging
          // Silently ignore — protocol recordings capture all messages for debugging.
          break;
      }
    } catch (err) {
      console.error(`[codex-adapter] Error handling notification ${method}:`, err);
    }
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

  // ── Incoming request handlers (approval requests) ───────────────────────

  private handleRequest(method: string, id: number, params: Record<string, unknown>): void {
    try {
      this.approvalManager.handleRequest(method, id, params);
    } catch (err) {
      console.error(`[codex-adapter] Error handling request ${method}:`, err);
    }
  }

  private handleThreadStatusChanged(params: Record<string, unknown>): void {
    const status = params.status as Record<string, unknown> | undefined;
    if (!status) return;
    const threadId = this.getThreadIdFromParams(params);
    if (threadId && this.threadId && threadId !== this.threadId) return;

    if (status.type === "idle" && this.currentTurnId) {
      const staleTurnId = this.currentTurnId;
      console.log(
        `[codex-adapter] Thread reported idle while currentTurnId=${staleTurnId} is set; clearing stale turn for session ${this.sessionId}`,
      );
      this.currentTurnId = null;
      for (const resolve of this.turnEndResolvers.splice(0)) resolve();
      const routerError = this.toolRouterErrorByTurnId.get(staleTurnId);
      if (routerError) {
        this.toolRouterErrorByTurnId.delete(staleTurnId);
        this.suppressedTurnResultIds.add(staleTurnId);
        this.emitTurnResult({
          turnId: staleTurnId,
          status: "failed",
          errorMessage: routerError,
        });
      }
    }
  }

  private handleTurnCompleted(params: Record<string, unknown>): void {
    const turn = params.turn as { id: string; status: string; error?: { message: string } } | undefined;
    const threadId = this.getThreadIdFromParams(params);
    if (threadId && this.threadId && threadId !== this.threadId) {
      return;
    }

    this.currentTurnId = null;
    if (typeof turn?.id === "string") {
      this.toolRouterErrorByTurnId.delete(turn.id);
    }
    // Wake any callers waiting for the turn to end (e.g. interruptAndWaitForTurnEnd)
    for (const resolve of this.turnEndResolvers.splice(0)) resolve();

    if (typeof turn?.id === "string" && this.suppressedTurnResultIds.delete(turn.id)) {
      return;
    }

    // Always emit a result — even for interrupted turns — so the server
    // transitions to idle. For internal interrupts (new message while a turn
    // was active), the next turn/start will immediately set generating=true
    // again, so the brief idle flash is imperceptible.
    this.emitTurnResult({
      turnId: typeof turn?.id === "string" ? turn.id : null,
      status: turn?.status || "end_turn",
      errorMessage: turn?.error?.message,
    });
  }

  private emitTurnResult(args: { turnId?: string | null; status: string; errorMessage?: string }): void {
    const isSuccess = args.status === "completed" || args.status === "interrupted";
    const result: CLIResultMessage = {
      type: "result",
      subtype: isSuccess ? "success" : "error_during_execution",
      is_error: !isSuccess,
      result: args.errorMessage,
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 1,
      total_cost_usd: 0,
      stop_reason: args.status,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      ...(typeof args.turnId === "string" ? { codex_turn_id: args.turnId } : {}),
      uuid: randomUUID(),
      session_id: this.sessionId,
    };

    this.emit({ type: "result", data: result });
  }

  private isToolRouterFailureMessage(message: string): boolean {
    return [
      /\bapply_patch verification failed\b/i,
      /\b(?:exec_command|write_stdin|view_image|spawn_agent|send_input|resume_agent|wait_agent|close_agent)\s+failed\b/i,
      /\btool(?:\s+call)?\s+failed\b/i,
    ].some((pattern) => pattern.test(message));
  }

  private updateRateLimits(data: Record<string, unknown>): void {
    const normalizeLimit = (value: unknown) => {
      if (!value || typeof value !== "object") return null;
      const raw = value as Record<string, unknown>;
      const usedRaw = Number(raw.usedPercent ?? 0);
      // Codex has been observed to report this as either 0..100 or 0..1.
      // Use strict < 1 to avoid treating usedPercent:1 (1%) as 0..1 format → 100%.
      const normalizedPercent = Number.isFinite(usedRaw) ? (usedRaw > 0 && usedRaw < 1 ? usedRaw * 100 : usedRaw) : 0;
      const usedPercent = Math.max(0, Math.min(100, normalizedPercent));
      const windowDurationMins = Number(raw.windowDurationMins ?? 0);
      let resetsAt = 0;
      const rawResetsAt = raw.resetsAt;
      if (typeof rawResetsAt === "number" && Number.isFinite(rawResetsAt)) {
        resetsAt = rawResetsAt;
      } else if (typeof rawResetsAt === "string") {
        const asNumber = Number(rawResetsAt);
        if (Number.isFinite(asNumber)) {
          resetsAt = asNumber;
        } else {
          const asDateMs = Date.parse(rawResetsAt);
          if (Number.isFinite(asDateMs)) resetsAt = asDateMs;
        }
      }
      return {
        usedPercent,
        windowDurationMins: Number.isFinite(windowDurationMins) ? windowDurationMins : 0,
        resetsAt,
      };
    };
    const normalizeRateLimitSet = (value: unknown) => {
      if (!value || typeof value !== "object") return null;
      const raw = value as Record<string, unknown>;
      return {
        primary: normalizeLimit(raw.primary),
        secondary: normalizeLimit(raw.secondary),
      };
    };

    const direct = data?.rateLimits as Record<string, unknown> | undefined;
    const directNormalized = normalizeRateLimitSet(direct);
    const directLimitId = typeof direct?.limitId === "string" ? direct.limitId : null;
    if (directLimitId && directNormalized) {
      this.rateLimitsByLimitId.set(directLimitId, directNormalized);
    }

    const byId = data?.rateLimitsByLimitId as Record<string, unknown> | undefined;
    if (byId && typeof byId === "object") {
      for (const [limitId, limitData] of Object.entries(byId)) {
        const parsed = normalizeRateLimitSet(limitData);
        if (parsed) this.rateLimitsByLimitId.set(limitId, parsed);
      }
    }

    this._rateLimits =
      this.rateLimitsByLimitId.get("codex") ??
      (directLimitId ? (this.rateLimitsByLimitId.get(directLimitId) ?? null) : null) ??
      directNormalized ??
      null;

    if (!this._rateLimits) return;

    // Forward rate limits to browser for UI display
    this.emit({
      type: "session_update",
      session: {
        codex_rate_limits: {
          primary: this._rateLimits.primary,
          secondary: this._rateLimits.secondary,
        },
      },
    });
  }

  private handleTokenUsageUpdated(params: Record<string, unknown>): void {
    // Codex sends: { threadId, turnId, tokenUsage: {
    //   total: { totalTokens, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens },
    //   last: { totalTokens, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens },
    //   modelContextWindow: 258400
    // }}
    // IMPORTANT: `total` is cumulative across all turns and can far exceed the context window.
    // `last` is the most recent turn — its inputTokens reflects what's actually in context.
    const threadId = this.getThreadIdFromParams(params);
    if (threadId && this.threadId && threadId !== this.threadId) return;
    const tokenUsage = params.tokenUsage as Record<string, unknown> | undefined;
    if (!tokenUsage) return;

    const total = tokenUsage.total as Record<string, number> | undefined;
    const last = tokenUsage.last as Record<string, number> | undefined;
    const contextWindow = tokenUsage.modelContextWindow as number | undefined;

    const updates: Partial<SessionState> = {};

    // Use last turn's input tokens for context usage — that's what's actually in
    // the window. Adapts Codex field names to the shared TokenUsage interface.
    if (last && contextWindow && contextWindow > 0) {
      const usage: TokenUsage = {
        input_tokens: last.inputTokens || 0,
        cache_read_input_tokens: last.cachedInputTokens || 0,
      };
      const contextTokensUsed = computeContextTokensUsed(usage);
      const pct = computeContextUsedPercent(usage, contextWindow);
      if (typeof contextTokensUsed === "number") {
        updates.codex_token_details = {
          ...(updates.codex_token_details ?? {
            inputTokens: total?.inputTokens || 0,
            outputTokens: total?.outputTokens || 0,
            cachedInputTokens: total?.cachedInputTokens || 0,
            reasoningOutputTokens: total?.reasoningOutputTokens || 0,
            modelContextWindow: contextWindow || 0,
          }),
          contextTokensUsed,
        };
      }
      if (typeof pct === "number") {
        updates.context_used_percent = pct;
      }
    }

    // Forward cumulative token breakdown for display in the UI
    if (total) {
      updates.codex_token_details = {
        contextTokensUsed: updates.codex_token_details?.contextTokensUsed,
        inputTokens: total.inputTokens || 0,
        outputTokens: total.outputTokens || 0,
        cachedInputTokens: total.cachedInputTokens || 0,
        reasoningOutputTokens: total.reasoningOutputTokens || 0,
        modelContextWindow: contextWindow || 0,
      };
    }

    if (Object.keys(updates).length > 0) {
      this.emit({
        type: "session_update",
        session: updates,
      });
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private emit(msg: BrowserIncomingMessage): void {
    this.browserMessageCb?.(msg);
  }

  private buildResumeSnapshot(thread: Record<string, unknown> & { id: string }): CodexResumeSnapshot | null {
    const rawTurns = Array.isArray(thread.turns) ? thread.turns : [];
    const turns = rawTurns.filter((t): t is Record<string, unknown> => !!t && typeof t === "object");
    const normalizedTurns = turns.map((turn) => {
      const turnId = typeof turn.id === "string" ? turn.id : "";
      const status = typeof turn.status === "string" ? turn.status : null;
      const items = Array.isArray(turn.items)
        ? turn.items.filter((it): it is Record<string, unknown> => !!it && typeof it === "object")
        : [];
      return {
        id: turnId,
        status,
        error: turn.error ?? null,
        items,
      } satisfies CodexResumeTurnSnapshot;
    });
    const last = normalizedTurns.length > 0 ? normalizedTurns[normalizedTurns.length - 1] : null;

    // Extract thread-level status (e.g. {type: "idle"} or {type: "active"})
    const rawStatus = thread.status;
    const threadStatus =
      typeof rawStatus === "object" && rawStatus !== null
        ? String((rawStatus as Record<string, unknown>).type ?? "")
        : typeof rawStatus === "string"
          ? rawStatus
          : null;

    if (!last) {
      return {
        threadId: thread.id,
        turnCount: 0,
        turns: [],
        lastTurn: null,
        threadStatus,
      };
    }

    return {
      threadId: thread.id,
      turnCount: normalizedTurns.length,
      turns: normalizedTurns,
      lastTurn: last,
      threadStatus,
    };
  }

  private mapApprovalPolicy(mode?: string, askPermission?: boolean): string {
    if (askPermission === false) return "never";
    switch (mode) {
      case "bypassPermissions":
        return "never";
      case "suggest":
      case "plan":
      case "acceptEdits":
      case "default":
      default:
        return "untrusted";
    }
  }

  private mapSandboxPolicy(mode?: string): string {
    switch (mode) {
      case "bypassPermissions":
        return "danger-full-access";
      default:
        return "workspace-write";
    }
  }

  private buildCollaborationModeOverride(): {
    mode: "default" | "plan";
    settings: { model: string; reasoning_effort: string | null };
  } | null {
    const mode = this.options.approvalMode === "plan" ? "plan" : "default";
    return {
      mode,
      settings: {
        model: this.options.model?.trim() || getDefaultModelForBackend("codex"),
        reasoning_effort: this.normalizeReasoningEffort(this.options.reasoningEffort),
      },
    };
  }

  private async configureDeveloperInstructions(): Promise<void> {
    const instructions = this.options.instructions;
    if (!instructions?.trim()) return;

    // CliLauncher runs Codex with a per-session CODEX_HOME, so this config
    // write scopes guardrails to the Takode session rather than global Codex.
    await this.transport.call("config/value/write", {
      keyPath: "developer_instructions",
      value: instructions,
      mergeStrategy: "replace",
    });
  }

  private normalizeReasoningEffort(effort?: string): string | null {
    if (!effort) return null;
    const normalized = effort.trim().toLowerCase();
    if (!normalized) return null;
    return CodexAdapter.VALID_REASONING_EFFORTS.has(normalized) ? normalized : null;
  }

  private isCollaborationModeUnsupportedError(err: unknown): boolean {
    const text = String(err).toLowerCase();
    return (
      text.includes("collaborationmode") &&
      (text.includes("unknown field") ||
        text.includes("invalid params") ||
        text.includes("-32602") ||
        text.includes("experimentalapi"))
    );
  }

  private isTransportClosedError(err: unknown): boolean {
    return String(err).toLowerCase().includes("transport closed");
  }

  private isRecoverableTurnStartError(err: unknown): boolean {
    const text = String(err).toLowerCase();
    return this.isTransportClosedError(err) || text.includes("turn/start timed out");
  }

  private formatInitializationError(err: unknown): string {
    const detail = err instanceof Error ? err.message : String(err);
    let message = `Codex initialization failed: ${detail}`;
    const failureContext = this.options.failureContextProvider?.();
    if (failureContext && this.isTransportClosedError(err)) {
      message += `. Stderr: ${failureContext}`;
    }
    return message;
  }

  private handleTurnStartDispatchFailure(msg: BrowserOutgoingMessage): boolean {
    if (!this.turnStartFailedCb) return false;
    this.turnStartFailedCb(msg);
    return true;
  }
}
