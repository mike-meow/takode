// Types for the WebSocket bridge between Claude Code CLI and the browser

// ─── CLI Message Types (NDJSON from Claude Code CLI) ──────────────────────────

export interface CLISystemInitMessage {
  type: "system";
  subtype: "init";
  cwd: string;
  session_id: string;
  tools: string[];
  mcp_servers: { name: string; status: string }[];
  model: string;
  permissionMode: string;
  apiKeySource: string;
  claude_code_version: string;
  slash_commands: string[];
  agents?: string[];
  skills?: string[];
  output_style: string;
  uuid: string;
}

export interface CLISystemStatusMessage {
  type: "system";
  subtype: "status";
  status: "compacting" | null;
  permissionMode?: string;
  uuid: string;
  session_id: string;
}

export interface CodexSkillReference {
  name: string;
  path: string;
  description?: string;
}

export interface CodexAppReference {
  id: string;
  name: string;
  description?: string | null;
}

export interface CLISystemCompactBoundaryMessage {
  type: "system";
  subtype: "compact_boundary";
  compact_metadata?: {
    trigger?: "auto" | "manual";
    pre_tokens?: number;
  };
  uuid: string;
  session_id: string;
}

export interface CLISystemTaskNotificationMessage {
  type: "system";
  subtype: "task_notification";
  task_id: string;
  tool_use_id: string;
  status: string;
  output_file?: string;
  summary?: string;
  uuid?: string;
  session_id?: string;
}

export interface CLIAssistantMessage {
  type: "assistant";
  message: {
    id: string;
    type: "message";
    role: "assistant";
    model: string;
    content: ContentBlock[];
    stop_reason: string | null;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    };
  };
  parent_tool_use_id: string | null;
  error?: string;
  uuid: string;
  session_id: string;
}

export interface CLIResultMessage {
  type: "result";
  subtype:
    | "success"
    | "error_during_execution"
    | "error_max_turns"
    | "error_max_budget_usd"
    | "error_max_structured_output_retries";
  is_error: boolean;
  result?: string;
  errors?: string[];
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  total_cost_usd: number;
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
  // Observed from recordings: modelUsage totals are cumulative across the session
  // (for cost/accounting), not per-turn usage.
  modelUsage?: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      contextWindow: number;
      maxOutputTokens: number;
      costUSD: number;
    }
  >;
  total_lines_added?: number;
  total_lines_removed?: number;
  /** Codex turn id when this result was synthesized from a Codex turn/completed event. */
  codex_turn_id?: string;
  uuid: string;
  session_id: string;
}

export interface CLIStreamEventMessage {
  type: "stream_event";
  event: unknown;
  parent_tool_use_id: string | null;
  uuid: string;
  session_id: string;
}

export interface CLIToolProgressMessage {
  type: "tool_progress";
  tool_use_id: string;
  tool_name: string;
  parent_tool_use_id: string | null;
  elapsed_time_seconds: number;
  output_delta?: string;
  uuid: string;
  session_id: string;
}

export interface CLIToolUseSummaryMessage {
  type: "tool_use_summary";
  summary: string;
  preceding_tool_use_ids: string[];
  uuid: string;
  session_id: string;
}

export interface CLIControlRequestMessage {
  type: "control_request";
  request_id: string;
  request: {
    subtype: "can_use_tool";
    tool_name: string;
    input: Record<string, unknown>;
    permission_suggestions?: PermissionUpdate[];
    description?: string;
    tool_use_id: string;
    agent_id?: string;
  };
}

export interface CLIKeepAliveMessage {
  type: "keep_alive";
}

export interface CLIAuthStatusMessage {
  type: "auth_status";
  isAuthenticating: boolean;
  output: string[];
  error?: string;
  uuid: string;
  session_id: string;
}

export interface CLIControlResponseMessage {
  type: "control_response";
  response: {
    subtype: "success" | "error";
    request_id: string;
    response?: Record<string, unknown>;
    error?: string;
  };
}

/** CLI cancels a pending control_request it previously sent (e.g. after interrupt or hook auto-approval) */
export interface CLIControlCancelRequestMessage {
  type: "control_cancel_request";
  request_id: string;
}

export interface CLIUserMessage {
  type: "user";
  message: {
    role: "user";
    content: ContentBlock[] | string;
  };
  parent_tool_use_id: string | null;
  tool_use_result?: Record<string, unknown>;
  uuid: string;
  session_id: string;
}

export type CLIMessage =
  | CLISystemInitMessage
  | CLISystemStatusMessage
  | CLISystemCompactBoundaryMessage
  | CLISystemTaskNotificationMessage
  | CLIAssistantMessage
  | CLIResultMessage
  | CLIStreamEventMessage
  | CLIToolProgressMessage
  | CLIToolUseSummaryMessage
  | CLIControlRequestMessage
  | CLIControlResponseMessage
  | CLIControlCancelRequestMessage
  | CLIKeepAliveMessage
  | CLIAuthStatusMessage
  | CLIUserMessage;

// ─── Tool Result Preview ─────────────────────────────────────────────────────

export interface ToolResultPreview {
  tool_use_id: string;
  /** Truncated content (last TOOL_RESULT_PREVIEW_LIMIT chars) */
  content: string;
  is_error: boolean;
  /** Original content size in characters */
  total_size: number;
  /** Whether the preview was truncated */
  is_truncated: boolean;
  /** Wall-clock duration in seconds (tool_use → tool_result), rounded to 0.1s. Omitted if unknown. */
  duration_seconds?: number;
}

export const TOOL_RESULT_PREVIEW_LIMIT = 300;

// ─── Content Block Types ──────────────────────────────────────────────────────

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean }
  | { type: "thinking"; thinking: string; budget_tokens?: number; thinking_time_ms?: number };

export interface VsCodeSelectionMetadata {
  absolutePath: string;
  relativePath: string;
  displayPath: string;
  startLine: number;
  endLine: number;
  lineCount: number;
}

/**
 * Format a VSCode selection into a text prompt that tells the model which file
 * and line range the user has selected. Used by ws-bridge (CLI path),
 * claude-sdk-adapter, and codex-adapter when forwarding user messages.
 */
export function formatVsCodeSelectionPrompt(selection: VsCodeSelectionMetadata): string {
  if (selection.startLine === selection.endLine) {
    return `[user selection in VSCode: ${selection.relativePath} line ${selection.startLine}] (this may or may not be relevant)`;
  }
  return `[user selection in VSCode: ${selection.relativePath} lines ${selection.startLine}-${selection.endLine}] (this may or may not be relevant)`;
}

export interface VsCodeSelectionSnapshot {
  absolutePath: string;
  startLine: number;
  endLine: number;
  lineCount: number;
}

export interface VsCodeSelectionState {
  selection: VsCodeSelectionSnapshot | null;
  updatedAt: number;
  sourceId: string;
  sourceType: "browser-panel" | "vscode-window";
  sourceLabel?: string;
}

export interface VsCodeWindowState {
  sourceId: string;
  sourceType: "vscode-window";
  sourceLabel?: string;
  workspaceRoots: string[];
  updatedAt: number;
  lastActivityAt: number;
  lastSeenAt: number;
}

export interface VsCodeOpenFileTarget {
  absolutePath: string;
  line: number;
  column: number;
  endLine?: number;
}

export interface VsCodeOpenFileCommand {
  commandId: string;
  sourceId: string;
  target: VsCodeOpenFileTarget;
  createdAt: number;
}

export interface PendingCodexInputImageDraft {
  name: string;
  base64: string;
  mediaType: string;
}

export interface PendingCodexInput {
  id: string;
  content: string;
  timestamp: number;
  cancelable: boolean;
  imageRefs?: import("./image-store.js").ImageRef[];
  draftImages?: PendingCodexInputImageDraft[];
  deliveryContent?: string;
  localImagePaths?: string[];
  agentSource?: { sessionId: string; sessionLabel?: string };
  vscodeSelection?: VsCodeSelectionMetadata;
}

export interface CodexPendingBatchInput {
  content: string;
  local_images?: string[];
  vscodeSelection?: VsCodeSelectionMetadata;
}

// ─── Browser Message Types (browser <-> bridge) ──────────────────────────────

/** Messages the browser sends to the bridge */
export type BrowserOutgoingMessage =
  | {
      type: "user_message";
      content: string;
      session_id?: string;
      images?: { media_type: string; data: string }[];
      vscodeSelection?: VsCodeSelectionMetadata;
      /**
       * Codex-internal transport optimization: local file paths forwarded as
       * `UserInput::LocalImage` entries instead of inline data: URLs.
       */
      local_images?: string[];
      client_msg_id?: string;
      /** Present when the message was injected programmatically (e.g. via takode CLI or cron). */
      agentSource?: { sessionId: string; sessionLabel?: string };
    }
  | {
      type: "codex_start_pending";
      pendingInputIds: string[];
      inputs: CodexPendingBatchInput[];
    }
  | {
      type: "codex_steer_pending";
      pendingInputIds: string[];
      expectedTurnId: string;
      inputs: CodexPendingBatchInput[];
    }
  | {
      type: "vscode_selection_update";
      selection: VsCodeSelectionSnapshot | null;
      updatedAt: number;
      sourceId: string;
      sourceType: "browser-panel" | "vscode-window";
      sourceLabel?: string;
      client_msg_id?: string;
    }
  | {
      type: "permission_response";
      request_id: string;
      behavior: "allow" | "deny";
      updated_input?: Record<string, unknown>;
      updated_permissions?: PermissionUpdate[];
      message?: string;
      client_msg_id?: string;
    }
  | { type: "session_subscribe"; last_seq: number; known_frozen_count?: number; known_frozen_hash?: string }
  | {
      type: "history_sync_mismatch";
      frozen_count: number;
      expected_frozen_hash: string;
      actual_frozen_hash: string;
      expected_full_hash: string;
      actual_full_hash: string;
    }
  | { type: "session_ack"; last_seq: number }
  | { type: "interrupt"; client_msg_id?: string; interruptSource?: "user" | "leader" | "system" }
  | { type: "cancel_pending_codex_input"; id: string; client_msg_id?: string }
  | { type: "set_model"; model: string; client_msg_id?: string }
  | { type: "set_codex_reasoning_effort"; effort: string; client_msg_id?: string }
  | { type: "set_permission_mode"; mode: string; client_msg_id?: string }
  | { type: "mcp_get_status"; client_msg_id?: string }
  | { type: "mcp_toggle"; serverName: string; enabled: boolean; client_msg_id?: string }
  | { type: "mcp_reconnect"; serverName: string; client_msg_id?: string }
  | { type: "mcp_set_servers"; servers: Record<string, McpServerConfig>; client_msg_id?: string }
  | { type: "set_ask_permission"; askPermission: boolean; client_msg_id?: string }
  | { type: "permission_user_viewing"; request_id: string };

// Quest Journey state machine -- canonical source in shared/quest-journey.ts
export { QUEST_JOURNEY_STATES, QUEST_JOURNEY_HINTS } from "../shared/quest-journey.js";
export type { QuestJourneyState } from "../shared/quest-journey.js";

/** A single row on the leader's work board. */
export interface BoardRow {
  questId: string;
  /** Short title of the quest (cached for display). */
  title?: string;
  /** Session ID of the assigned worker (optional). */
  worker?: string;
  /** Session number of the assigned worker (optional, cached for display). */
  workerNum?: number;
  /** Quest Journey state -- each state = a leader action that just happened. */
  status?: string;
  /** Quest IDs this quest is blocked on (dependency or capacity). */
  waitFor?: string[];
  /** Epoch ms when this row was first added to the board. Used for stable sort. */
  createdAt: number;
  /** Epoch ms when this row was last updated. */
  updatedAt: number;
}

/** High-level task recognized by the session auto-namer. */
export interface SessionTaskEntry {
  title: string;
  action: "name" | "revise" | "new";
  timestamp: number;
  /** ID of the user message that triggered this naming evaluation. */
  triggerMessageId: string;
  /** When "quest", this entry was created by claiming a quest (not by the auto-namer). */
  source?: "quest";
  /** Present for quest-sourced entries so UI can deep-link to Questmaster details. */
  questId?: string;
}

/** Messages the bridge sends to the browser */
export type BrowserIncomingMessageBase =
  | { type: "session_init"; session: SessionState; nextEventSeq?: number }
  | { type: "session_update"; session: Partial<SessionState> }
  | {
      type: "assistant";
      message: CLIAssistantMessage["message"];
      parent_tool_use_id: string | null;
      timestamp?: number;
      uuid?: string;
      tool_start_times?: Record<string, number>;
      turn_duration_ms?: number;
      leader_user_addressed?: boolean;
      notification?: { category: "needs-input" | "review"; timestamp: number };
    }
  | { type: "stream_event"; event: unknown; parent_tool_use_id: string | null }
  | { type: "result"; data: CLIResultMessage }
  | { type: "permission_request"; request: PermissionRequest }
  | { type: "permission_cancelled"; request_id: string }
  | {
      type: "tool_progress";
      tool_use_id: string;
      tool_name: string;
      elapsed_time_seconds: number;
      /** Codex-only: incremental terminal output chunk from commandExecution/outputDelta. */
      output_delta?: string;
    }
  | { type: "tool_use_summary"; summary: string; tool_use_ids: string[] }
  | { type: "status_change"; status: "compacting" | "reverting" | "idle" | "running" | null }
  | { type: "permissions_cleared" }
  | { type: "auth_status"; isAuthenticating: boolean; output: string[]; error?: string }
  | { type: "error"; message: string }
  | { type: "backend_disconnected"; reason?: "idle_limit" | "broken" }
  | { type: "backend_connected" }
  | { type: "vscode_selection_state"; state: VsCodeSelectionState | null }
  | {
      type: "user_message";
      content: string;
      timestamp: number;
      id?: string;
      cliUuid?: string;
      images?: import("./image-store.js").ImageRef[];
      agentSource?: { sessionId: string; sessionLabel?: string };
      vscodeSelection?: VsCodeSelectionMetadata;
    }
  | { type: "codex_pending_inputs"; inputs: PendingCodexInput[] }
  | { type: "codex_pending_input_cancelled"; input: PendingCodexInput }
  | { type: "message_history"; messages: BrowserIncomingMessage[] }
  | {
      type: "history_sync";
      frozen_base_count: number;
      frozen_delta: BrowserIncomingMessage[];
      hot_messages: BrowserIncomingMessage[];
      frozen_count: number;
      expected_frozen_hash: string;
      expected_full_hash: string;
    }
  | { type: "event_replay"; events: BufferedBrowserEvent[] }
  | { type: "session_order_update"; sessionOrder: Record<string, string[]> }
  | { type: "group_order_update"; groupOrder: string[] }
  | { type: "session_name_update"; name: string; source?: "quest" }
  | { type: "session_task_history"; tasks: SessionTaskEntry[] }
  | { type: "pr_status_update"; pr: import("./github-pr.js").GitHubPRInfo | null; available: boolean }
  | { type: "mcp_status"; servers: McpServerDetail[] }
  | { type: "compact_boundary"; id?: string; timestamp?: number; trigger?: string; preTokens?: number }
  | {
      type: "compact_marker";
      timestamp: number;
      id?: string;
      cliUuid?: string;
      summary?: string;
      trigger?: string;
      preTokens?: number;
    }
  | { type: "compact_summary"; summary: string }
  | { type: "tool_result_preview"; previews: ToolResultPreview[] }
  | {
      type: "permission_denied";
      id: string;
      tool_name: string;
      tool_use_id: string;
      summary: string;
      timestamp: number;
      request_id?: string;
    }
  | {
      type: "permission_approved";
      id: string;
      tool_name: string;
      tool_use_id: string;
      summary: string;
      timestamp: number;
      request_id?: string;
      answers?: { question: string; answer: string }[];
    }
  | {
      type: "permission_auto_approved";
      request_id: string;
      tool_name: string;
      tool_use_id: string;
      reason: string;
      summary: string;
      timestamp: number;
    }
  | {
      type: "permission_auto_denied";
      request_id: string;
      tool_name: string;
      tool_use_id: string;
      reason: string;
      timestamp: number;
    }
  | { type: "permission_needs_attention"; request_id: string; timestamp: number; reason?: string }
  | {
      type: "leader_group_idle";
      leader_session_id: string;
      leader_label: string;
      member_count: number;
      idle_for_ms: number;
      timestamp: number;
    }
  | { type: "permission_evaluating_status"; request_id: string; evaluating: "queued" | "evaluating"; timestamp: number }
  | {
      type: "state_snapshot";
      sessionStatus: string | null;
      permissionMode: string;
      backendConnected: boolean;
      backendState?: SessionState["backend_state"];
      backendError?: string | null;
      uiMode: string | null;
      askPermission: boolean;
      lastReadAt?: number;
      attentionReason?: "action" | "error" | "review" | null;
      generationStartedAt?: number | null;
      board?: BoardRow[];
    }
  | { type: "session_stuck" }
  | { type: "session_unstuck" }
  | { type: "quest_list_updated" }
  | { type: "session_quest_claimed"; quest: { id: string; title: string; status?: string } | null }
  | {
      type: "task_notification";
      task_id: string;
      tool_use_id: string;
      status: string;
      output_file?: string;
      summary?: string;
    }
  | { type: "session_deleted"; session_id: string }
  | { type: "session_created"; session_id: string }
  | {
      type: "notification_anchored";
      messageId: string | null;
      notification: { category: "needs-input" | "review"; timestamp: number };
    }
  | { type: "board_updated"; board: BoardRow[] };

export type BrowserIncomingMessage = BrowserIncomingMessageBase & { seq?: number };

export type ReplayableBrowserIncomingMessage = Exclude<BrowserIncomingMessageBase, { type: "event_replay" }>;

export interface BufferedBrowserEvent {
  seq: number;
  message: ReplayableBrowserIncomingMessage;
}

// ─── Session State ────────────────────────────────────────────────────────────

export type BackendType = "claude" | "codex" | "claude-sdk";

/** Exhaustive check — TypeScript errors if a switch doesn't cover all cases. */
export function assertNever(x: never, msg?: string): never {
  throw new Error(msg ?? `Unexpected value: ${JSON.stringify(x)}`);
}

/** True for backends using Claude Code (CLI WebSocket or SDK stdio). */
export function isClaudeFamily(backend: BackendType): boolean {
  return backend === "claude" || backend === "claude-sdk";
}

export type CodexOutboundTurnStatus =
  | "queued"
  | "dispatched"
  | "backend_acknowledged"
  | "completed"
  | "blocked_broken_session";

export interface CodexOutboundTurn {
  adapterMsg: BrowserOutgoingMessage;
  userMessageId: string;
  pendingInputIds?: string[];
  userContent: string;
  historyIndex: number;
  status: CodexOutboundTurnStatus;
  dispatchCount: number;
  createdAt: number;
  updatedAt: number;
  acknowledgedAt: number | null;
  turnTarget: "current" | "queued" | null;
  lastError: string | null;
  turnId: string | null;
  disconnectedAt: number | null;
  resumeConfirmedAt: number | null;
}

export interface SessionState {
  session_id: string;
  backend_type?: BackendType;
  /** Server-authored backend lifecycle state. */
  backend_state?: "initializing" | "resuming" | "connected" | "disconnected" | "broken";
  /** Server-authored backend failure detail for disconnected/broken states. */
  backend_error?: string | null;
  model: string;
  cwd: string;
  tools: string[];
  permissionMode: string;
  claude_code_version: string;
  mcp_servers: { name: string; status: string }[];
  agents: string[];
  slash_commands: string[];
  skills: string[];
  /** Codex skill metadata used for `$` mention insertion. */
  skill_metadata?: CodexSkillReference[];
  /** Codex app metadata used for `$` mention insertion. */
  apps?: CodexAppReference[];
  total_cost_usd: number;
  num_turns: number;
  context_used_percent: number;
  is_compacting: boolean;
  git_branch: string;
  /** Current HEAD commit SHA (server-derived, used for history rewrite detection). */
  git_head_sha?: string;
  git_default_branch?: string;
  diff_base_branch?: string;
  /** Stable anchor commit for "agent-made diff" in worktree sessions. */
  diff_base_start_sha?: string;
  is_worktree: boolean;
  is_containerized: boolean;
  repo_root: string;
  git_ahead: number;
  git_behind: number;
  total_lines_added: number;
  total_lines_removed: number;
  // Codex-specific token details (forwarded from thread/tokenUsage/updated)
  codex_token_details?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    reasoningOutputTokens: number;
    modelContextWindow: number;
  };
  // Claude/CloudCode token details (forwarded from result.modelUsage)
  claude_token_details?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    modelContextWindow: number;
  };
  // Codex-specific rate limits (forwarded from account/rateLimits/updated)
  codex_rate_limits?: {
    primary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
    secondary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
  };
  /** Codex reasoning effort (e.g. low/medium/high). */
  codex_reasoning_effort?: string;
  /** If this session was spawned by a cron job */
  cronJobId?: string;
  /** Human-readable name of the cron job that spawned this session */
  cronJobName?: string;
  /** UI mode: "plan" or "agent" — virtual concept, maps to CLI modes via askPermission */
  uiMode?: "plan" | "agent";
  /** Whether the session requires permission prompts for tool use (default: true) */
  askPermission?: boolean;
  /** Epoch ms when the user last viewed this session (server-only, never from CLI) */
  lastReadAt?: number;
  /** Current attention reason (server-only, never from CLI) */
  attentionReason?: "action" | "error" | "review" | null;
  /** Questmaster: ID of the quest claimed by this session */
  claimedQuestId?: string;
  /** Questmaster: title of the claimed quest (for display without fetching) */
  claimedQuestTitle?: string;
  /** Questmaster: current status of the claimed quest */
  claimedQuestStatus?: string;
}

// ─── MCP Types ───────────────────────────────────────────────────────────────

export interface McpServerConfig {
  type: "stdio" | "sse" | "http" | "sdk";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface McpServerDetail {
  name: string;
  status: "connected" | "failed" | "disabled" | "connecting";
  serverInfo?: unknown;
  error?: string;
  config: { type: string; url?: string; command?: string; args?: string[] };
  scope: string;
  tools?: { name: string; annotations?: { readOnly?: boolean; destructive?: boolean; openWorld?: boolean } }[];
}

// ─── Permission Request ──────────────────────────────────────────────────────

// ─── Permission Rule Types ───────────────────────────────────────────────────

export type PermissionDestination = "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg";

export type PermissionUpdate =
  | {
      type: "addRules";
      rules: { toolName: string; ruleContent?: string }[];
      behavior: "allow" | "deny" | "ask";
      destination: PermissionDestination;
    }
  | {
      type: "replaceRules";
      rules: { toolName: string; ruleContent?: string }[];
      behavior: "allow" | "deny" | "ask";
      destination: PermissionDestination;
    }
  | {
      type: "removeRules";
      rules: { toolName: string; ruleContent?: string }[];
      behavior: "allow" | "deny" | "ask";
      destination: PermissionDestination;
    }
  | { type: "setMode"; mode: string; destination: PermissionDestination }
  | { type: "addDirectories"; directories: string[]; destination: PermissionDestination }
  | { type: "removeDirectories"; directories: string[]; destination: PermissionDestination };

export interface PermissionRequest {
  request_id: string;
  tool_name: string;
  input: Record<string, unknown>;
  permission_suggestions?: PermissionUpdate[];
  description?: string;
  tool_use_id: string;
  agent_id?: string;
  timestamp: number;
  /** Auto-approval status: "queued" (waiting for semaphore slot), "evaluating" (LLM call in progress).
   *  Falsy/undefined means not in auto-approval flow — show full Allow/Deny UI. */
  evaluating?: "queued" | "evaluating";
  /** Set when the LLM auto-approver approved this permission. The reason string explains why.
   *  PermissionBanner uses this to show a brief "auto-approved" indicator instead of vanishing
   *  the dialog when the user was actively viewing it. */
  autoApproved?: string;
  /** Set when the LLM auto-approver deferred this permission to the human.
   *  Explains why: LLM rationale (for "defer"), "evaluation timed out", or "evaluation failed". */
  deferralReason?: string;
}

// ─── Session Creation Progress (SSE streaming) ──────────────────────────────

export type CreationStepId =
  | "resolving_env"
  | "fetching_git"
  | "checkout_branch"
  | "pulling_git"
  | "creating_worktree"
  | "pulling_image"
  | "building_image"
  | "creating_container"
  | "copying_workspace"
  | "running_init_script"
  | "launching_cli";

export interface CreationProgressEvent {
  step: CreationStepId;
  label: string;
  status: "in_progress" | "done" | "error";
  detail?: string;
}

// ─── Takode Orchestration Events ─────────────────────────────────────────────

export type TakodeEventType =
  | "turn_end"
  | "turn_start"
  | "compaction_started"
  | "compaction_finished"
  | "permission_request"
  | "permission_resolved"
  | "session_disconnected"
  | "session_error"
  | "session_archived"
  | "session_deleted"
  | "user_message";

export interface TakodeTurnEndMsgRange {
  from: number;
  to: number;
}

export interface TakodeTurnEndQuestChange {
  questId: string;
  from: string;
  to: string;
}

export interface TakodeTurnEndUserMessages {
  count: number;
  ids: number[];
}

export interface TakodeTurnStartEventData {
  reason?: string;
  userMessage?: string;
}

export interface TakodeTurnEndEventData {
  reason?: string;
  duration_ms: number;
  is_error?: boolean;
  interrupted?: boolean;
  interrupt_source?: "user" | "leader" | "system";
  compacted?: boolean;
  tools?: Record<string, number>;
  resultPreview?: string;
  msgRange?: TakodeTurnEndMsgRange;
  questChange?: TakodeTurnEndQuestChange;
  userMsgs?: TakodeTurnEndUserMessages;
  /** Who triggered this turn: "user" (direct chat), "leader" (orchestrator),
   *  "system" (internal injection), or "unknown" (no user message tracked). */
  turn_source?: "user" | "leader" | "system" | "unknown";
}

export interface TakodeCompactionEventData {
  context_used_percent?: number;
}

export interface TakodePermissionRequestEventData {
  tool_name: string;
  request_id?: string;
  summary?: string;
  question?: string;
  options?: string[];
  planPreview?: string;
  /** Who triggered the turn containing this permission request. */
  turn_source?: "user" | "leader" | "system" | "unknown";
  /** Index of the last assistant message in messageHistory when the permission was emitted. */
  msg_index?: number;
}

export interface TakodePermissionResolvedEventData {
  tool_name: string;
  outcome: "approved" | "denied";
}

export interface TakodeSessionDisconnectedEventData {
  wasGenerating: boolean;
  reason: string;
}

export interface TakodeSessionErrorEventData {
  error: string;
}

export type TakodeSessionLifecycleEventData = Record<string, never>;

export interface TakodeUserMessageEventData {
  content: string;
  agentSource?: {
    sessionId: string;
    sessionLabel?: string;
  };
}

export interface TakodeEventDataByType {
  turn_end: TakodeTurnEndEventData;
  turn_start: TakodeTurnStartEventData;
  compaction_started: TakodeCompactionEventData;
  compaction_finished: TakodeCompactionEventData;
  permission_request: TakodePermissionRequestEventData;
  permission_resolved: TakodePermissionResolvedEventData;
  session_disconnected: TakodeSessionDisconnectedEventData;
  session_error: TakodeSessionErrorEventData;
  session_archived: TakodeSessionLifecycleEventData;
  session_deleted: TakodeSessionLifecycleEventData;
  user_message: TakodeUserMessageEventData;
}

interface TakodeEventBase {
  /** Monotonic event ID for cursor-based catchup */
  id: number;
  /** Full session UUID */
  sessionId: string;
  /** Short integer session ID */
  sessionNum: number;
  /** Human-readable session name */
  sessionName: string;
  /** Epoch ms timestamp */
  ts: number;
}

export type TakodeEvent = {
  [E in TakodeEventType]: TakodeEventBase & {
    /** Event type */
    event: E;
    /** Event-specific payload */
    data: TakodeEventDataByType[E];
  };
}[TakodeEventType];

export type TakodeEventFor<E extends TakodeEventType> = Extract<TakodeEvent, { event: E }>;

/** Subscriber handle for the takode event stream */
export interface TakodeEventSubscriber {
  /** Session UUIDs this subscriber cares about */
  sessions: Set<string>;
  /** Callback invoked for each matching event */
  callback: (event: TakodeEvent) => void;
}
