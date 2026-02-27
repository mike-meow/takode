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
  subtype: "success" | "error_during_execution" | "error_max_turns" | "error_max_budget_usd" | "error_max_structured_output_retries";
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
  modelUsage?: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    contextWindow: number;
    maxOutputTokens: number;
    costUSD: number;
  }>;
  total_lines_added?: number;
  total_lines_removed?: number;
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

// ─── Browser Message Types (browser <-> bridge) ──────────────────────────────

/** Messages the browser sends to the bridge */
export type BrowserOutgoingMessage =
  | {
    type: "user_message";
    content: string;
    session_id?: string;
    images?: { media_type: string; data: string }[];
    /**
     * Codex-internal transport optimization: local file paths forwarded as
     * `UserInput::LocalImage` entries instead of inline data: URLs.
     */
    local_images?: string[];
    client_msg_id?: string;
  }
  | { type: "permission_response"; request_id: string; behavior: "allow" | "deny"; updated_input?: Record<string, unknown>; updated_permissions?: PermissionUpdate[]; message?: string; client_msg_id?: string }
  | { type: "session_subscribe"; last_seq: number }
  | { type: "session_ack"; last_seq: number }
  | { type: "interrupt"; client_msg_id?: string }
  | { type: "set_model"; model: string; client_msg_id?: string }
  | { type: "set_codex_reasoning_effort"; effort: string; client_msg_id?: string }
  | { type: "set_permission_mode"; mode: string; client_msg_id?: string }
  | { type: "mcp_get_status"; client_msg_id?: string }
  | { type: "mcp_toggle"; serverName: string; enabled: boolean; client_msg_id?: string }
  | { type: "mcp_reconnect"; serverName: string; client_msg_id?: string }
  | { type: "mcp_set_servers"; servers: Record<string, McpServerConfig>; client_msg_id?: string }
  | { type: "set_ask_permission"; askPermission: boolean; client_msg_id?: string };

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
  | { type: "assistant"; message: CLIAssistantMessage["message"]; parent_tool_use_id: string | null; timestamp?: number; uuid?: string; tool_start_times?: Record<string, number>; turn_duration_ms?: number }
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
  | { type: "cli_disconnected"; reason?: "idle_limit" }
  | { type: "cli_connected" }
  | { type: "user_message"; content: string; timestamp: number; id?: string; cliUuid?: string; images?: import("./image-store.js").ImageRef[] }
  | { type: "message_history"; messages: BrowserIncomingMessage[] }
  | { type: "event_replay"; events: BufferedBrowserEvent[] }
  | { type: "session_name_update"; name: string; source?: "quest" }
  | { type: "session_task_history"; tasks: SessionTaskEntry[] }
  | { type: "pr_status_update"; pr: import("./github-pr.js").GitHubPRInfo | null; available: boolean }
  | { type: "mcp_status"; servers: McpServerDetail[] }
  | { type: "compact_boundary"; trigger?: string; preTokens?: number }
  | { type: "compact_marker"; timestamp: number; id?: string; cliUuid?: string; summary?: string; trigger?: string; preTokens?: number }
  | { type: "compact_summary"; summary: string }
  | { type: "tool_result_preview"; previews: ToolResultPreview[] }
  | { type: "permission_denied"; id: string; tool_name: string; tool_use_id: string; summary: string; timestamp: number; request_id?: string }
  | { type: "permission_approved"; id: string; tool_name: string; tool_use_id: string; summary: string; timestamp: number; request_id?: string; answers?: { question: string; answer: string }[] }
  | { type: "permission_auto_approved"; request_id: string; tool_name: string; tool_use_id: string; reason: string; timestamp: number }
  | { type: "permission_auto_denied"; request_id: string; tool_name: string; tool_use_id: string; reason: string; timestamp: number }
  | { type: "permission_needs_attention"; request_id: string; timestamp: number }
  | { type: "state_snapshot"; sessionStatus: string | null; permissionMode: string; cliConnected: boolean; uiMode: string | null; askPermission: boolean; lastReadAt?: number; attentionReason?: "action" | "error" | "review" | null; generationStartedAt?: number | null }
  | { type: "session_stuck" }
  | { type: "quest_list_updated" }
  | { type: "session_quest_claimed"; quest: { id: string; title: string; status?: string } | null };

export type BrowserIncomingMessage = BrowserIncomingMessageBase & { seq?: number };

export type ReplayableBrowserIncomingMessage = Exclude<BrowserIncomingMessageBase, { type: "event_replay" }>;

export interface BufferedBrowserEvent {
  seq: number;
  message: ReplayableBrowserIncomingMessage;
}

// ─── Session State ────────────────────────────────────────────────────────────

export type BackendType = "claude" | "codex";

export interface SessionState {
  session_id: string;
  backend_type?: BackendType;
  model: string;
  cwd: string;
  tools: string[];
  permissionMode: string;
  claude_code_version: string;
  mcp_servers: { name: string; status: string }[];
  agents: string[];
  slash_commands: string[];
  skills: string[];
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
  | { type: "addRules"; rules: { toolName: string; ruleContent?: string }[]; behavior: "allow" | "deny" | "ask"; destination: PermissionDestination }
  | { type: "replaceRules"; rules: { toolName: string; ruleContent?: string }[]; behavior: "allow" | "deny" | "ask"; destination: PermissionDestination }
  | { type: "removeRules"; rules: { toolName: string; ruleContent?: string }[]; behavior: "allow" | "deny" | "ask"; destination: PermissionDestination }
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
  /** True while the LLM auto-approver is evaluating this request.
   *  Browser shows a collapsed spinner during this state. */
  evaluating?: boolean;
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
  | "permission_request"
  | "permission_resolved"
  | "quest_update"
  | "session_disconnected"
  | "session_error";

export interface TakodeEvent {
  /** Monotonic event ID for cursor-based catchup */
  id: number;
  /** Event type */
  event: TakodeEventType;
  /** Full session UUID */
  sessionId: string;
  /** Short integer session ID */
  sessionNum: number;
  /** Human-readable session name */
  sessionName: string;
  /** Epoch ms timestamp */
  ts: number;
  /** Event-specific payload */
  data: Record<string, unknown>;
}

/** Subscriber handle for the takode event stream */
export interface TakodeEventSubscriber {
  /** Session UUIDs this subscriber cares about */
  sessions: Set<string>;
  /** Callback invoked for each matching event */
  callback: (event: TakodeEvent) => void;
}
