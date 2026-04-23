import type {
  SessionState,
  CodexAppReference,
  CodexSkillReference,
  PermissionRequest,
  ContentBlock,
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  BackendType,
  McpServerDetail,
  McpServerConfig,
  CreationProgressEvent,
  ToolResultPreview,
  SessionTaskEntry,
  HistoryWindowState,
  PendingCodexInput,
  PendingCodexInputImageDraft,
  VsCodeSelectionMetadata,
  VsCodeSelectionState,
  SessionNotification,
} from "../server/session-types.js";
import { assertNever, isClaudeFamily } from "../server/session-types.js";
import type { ImageRef } from "../server/image-store.js";
import type { SessionTimer } from "../server/timer-types.js";
import type {
  QuestmasterTask,
  QuestStatus,
  QuestVerificationItem,
  QuestFeedbackEntry,
  QuestImage,
  QuestCreateInput,
  QuestPatchInput,
  QuestTransitionInput,
} from "../server/quest-types.js";

export type {
  SessionState,
  CodexAppReference,
  CodexSkillReference,
  PermissionRequest,
  ContentBlock,
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  BackendType,
  McpServerDetail,
  McpServerConfig,
  CreationProgressEvent,
  ToolResultPreview,
  SessionTaskEntry,
  HistoryWindowState,
  PendingCodexInput,
  PendingCodexInputImageDraft,
  ImageRef,
  VsCodeSelectionMetadata,
  VsCodeSelectionState,
  SessionTimer,
  SessionNotification,
};
export type { TreeGroup, TreeGroupState } from "../server/tree-group-store.js";
export { assertNever, isClaudeFamily };
export type {
  QuestmasterTask,
  QuestStatus,
  QuestVerificationItem,
  QuestFeedbackEntry,
  QuestImage,
  QuestCreateInput,
  QuestPatchInput,
  QuestTransitionInput,
};

/** Tool names that spawn subagent sessions. Older CLI versions use "Task",
 *  newer ones use "Agent". Both must be recognized for grouping and filtering. */
export const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(["Task", "Agent"]);
export function isSubagentToolName(name: string): boolean {
  return SUBAGENT_TOOL_NAMES.has(name);
}

export interface LocalImageAttachment {
  name: string;
  base64: string;
  mediaType: string;
}

export interface ComposerDraftImage extends LocalImageAttachment {
  id: string;
  status: "reading" | "uploading" | "ready" | "failed";
  error?: string;
  prepared?: {
    imageRef: ImageRef;
    path: string;
  };
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  contentBlocks?: ContentBlock[];
  images?: ImageRef[];
  localImages?: LocalImageAttachment[];
  timestamp: number;
  parentToolUseId?: string | null;
  isStreaming?: boolean;
  model?: string;
  stopReason?: string | null;
  /** Total wall-clock duration for the completed assistant turn. */
  turnDurationMs?: number;
  /** For system messages: "error" renders prominently, "denied" shows a compact denial chip, "approved" shows a green approval chip, "quest_claimed"/"quest_submitted" show collapsible quest details, default renders as subtle divider */
  variant?: "error" | "info" | "denied" | "approved" | "quest_claimed" | "quest_submitted" | "task_completed";
  /** Extra structured data for rich rendering (e.g. AskUserQuestion answers, quest claim details) */
  metadata?: {
    answers?: { question: string; answer: string }[];
    /** LLM rationale for auto-approved permissions (rendered separately from the summary). */
    autoApprovalReason?: string;
    vscodeSelection?: VsCodeSelectionMetadata;
    quest?: {
      questId: string;
      title: string;
      description?: string;
      status: string;
      tags?: string[];
      images?: QuestImage[];
      verificationItems?: QuestVerificationItem[];
    };
  };
  /** Present when this user message was injected programmatically (e.g. via takode CLI or cron). */
  agentSource?: { sessionId: string; sessionLabel?: string };
  /** Assistant message UUID from CLI, for revert support */
  cliUuid?: string;
  /** Notification anchored to this message (set by takode notify). */
  notification?: { category: "needs-input" | "review"; timestamp: number; summary?: string };
  /** Browser-only message not present in server messageHistory; excluded from sync hash verification. */
  ephemeral?: boolean;
  /** Browser-only pending upload/send state for local user messages. */
  pendingState?: "uploading" | "delivering" | "failed";
  pendingError?: string;
  clientMsgId?: string;
}

export interface PendingUserUpload {
  id: string;
  content: string;
  images: ComposerDraftImage[];
  timestamp: number;
  stage: "delivering" | "failed";
  error?: string;
  vscodeSelection?: VsCodeSelectionMetadata;
  prepared?: {
    deliveryContent: string;
    imageRefs: ImageRef[];
  };
}

export interface TaskItem {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed";
  owner?: string;
  blockedBy?: string[];
}

export interface SdkSessionInfo {
  sessionId: string;
  pid?: number;
  state: "starting" | "connected" | "running" | "exited";
  exitCode?: number | null;
  model?: string;
  permissionMode?: string;
  cwd: string;
  createdAt: number;
  /** The CLI's internal session ID (from system.init), used for `claude --resume` */
  cliSessionId?: string;
  archived?: boolean;
  /** Epoch ms when this session was archived */
  archivedAt?: number;
  /** Async cleanup state for archived worktree sessions. */
  worktreeCleanupStatus?: "pending" | "done" | "failed";
  /** Last background cleanup error, if any. */
  worktreeCleanupError?: string;
  /** Epoch ms when background cleanup started. */
  worktreeCleanupStartedAt?: number;
  /** Epoch ms when background cleanup finished. */
  worktreeCleanupFinishedAt?: number;
  containerId?: string;
  containerName?: string;
  containerImage?: string;
  name?: string;
  backendType?: BackendType;
  gitBranch?: string;
  gitDefaultBranch?: string;
  diffBaseBranch?: string;
  gitAhead?: number;
  gitBehind?: number;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
  /** If this session was spawned by a cron job */
  cronJobId?: string;
  /** Human-readable name of the cron job that spawned this session */
  cronJobName?: string;
  /** Number of active timers currently waiting on this session. */
  pendingTimerCount?: number;
  /** Truncated preview of the last user message */
  lastMessagePreview?: string;
  /** Whether the CLI process is currently connected (from REST API) */
  cliConnected?: boolean;
  /** Whether this session uses a git worktree */
  isWorktree?: boolean;
  /** The original repo root path (for worktree sessions) */
  repoRoot?: string;
  /** Whether the worktree directory still exists on disk (archived worktree sessions only) */
  worktreeExists?: boolean;
  /** Whether the worktree has uncommitted changes (archived worktree sessions only) */
  worktreeDirty?: boolean;
  /** Whether this is an assistant-mode session */
  isAssistant?: boolean;
  /** Whether this is a leader session (has herd/orchestration privileges) */
  isOrchestrator?: boolean;
  /** Session UUID of the leader that has herded this worker (single leader per session) */
  herdedBy?: string;
  /** Short integer session ID (e.g. #5), stable across restarts */
  sessionNum?: number | null;
  /** Server-authoritative attention state */
  attentionReason?: "action" | "error" | "review" | null;
  /** Epoch ms when user last viewed this session */
  lastReadAt?: number;
  /** Number of pending permission requests needing human attention. */
  pendingPermissionCount?: number;
  /** Human-readable summary of pending permission state (e.g. "pending plan"). */
  pendingPermissionSummary?: string | null;
  /** Task history from the session auto-namer */
  taskHistory?: SessionTaskEntry[];
  /** Accumulated search keywords from the session auto-namer */
  keywords?: string[];
  /** Current claimed quest status for sidebar/title rendering. */
  claimedQuestStatus?: string | null;
  /** Epoch ms of last real activity (user/assistant message, not keep_alive) */
  lastActivityAt?: number;
  /** Epoch ms of last user message (for sidebar activity sort -- not updated by assistant/tool activity) */
  lastUserMessageAt?: number;
  /** Last server-reported context usage percent for this session. */
  contextUsedPercent?: number;
  /** Number of completed turns in this session. */
  numTurns?: number;
  /** Approximate JSON byte size of the server-side message history. */
  messageHistoryBytes?: number;
  /** Codex-only retained payload estimate, including hidden full tool results. */
  codexRetainedPayloadBytes?: number;
  /** Last server-reported Codex token details for this session. */
  codexTokenDetails?: SessionState["codex_token_details"];
  /** Last server-reported Claude token details for this session. */
  claudeTokenDetails?: SessionState["claude_token_details"];
  /** The Companion-injected system prompt constructed at launch time (for debugging). */
  injectedSystemPrompt?: string;
  /** Session number of the parent session this reviewer is reviewing (reviewer lifecycle) */
  reviewerOf?: number;
}
