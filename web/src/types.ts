import type {
  SessionState,
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
  VsCodeSelectionMetadata,
} from "../server/session-types.js";
import { assertNever, isClaudeFamily } from "../server/session-types.js";
import type { ImageRef } from "../server/image-store.js";
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

export type { SessionState, PermissionRequest, ContentBlock, BrowserIncomingMessage, BrowserOutgoingMessage, BackendType, McpServerDetail, McpServerConfig, CreationProgressEvent, ToolResultPreview, SessionTaskEntry, ImageRef, VsCodeSelectionMetadata };
export { assertNever, isClaudeFamily };
export type { QuestmasterTask, QuestStatus, QuestVerificationItem, QuestFeedbackEntry, QuestImage, QuestCreateInput, QuestPatchInput, QuestTransitionInput };

/** Tool names that spawn subagent sessions. Older CLI versions use "Task",
 *  newer ones use "Agent". Both must be recognized for grouping and filtering. */
export const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(["Task", "Agent"]);
export function isSubagentToolName(name: string): boolean { return SUBAGENT_TOOL_NAMES.has(name); }

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  contentBlocks?: ContentBlock[];
  images?: ImageRef[];
  timestamp: number;
  parentToolUseId?: string | null;
  isStreaming?: boolean;
  model?: string;
  stopReason?: string | null;
  /** Total wall-clock duration for the completed assistant turn. */
  turnDurationMs?: number;
  /** For system messages: "error" renders prominently, "denied" shows a compact denial chip, "approved" shows a green approval chip, "quest_claimed"/"quest_submitted" show collapsible quest details, default renders as subtle divider */
  variant?: "error" | "info" | "denied" | "approved" | "quest_claimed" | "quest_submitted";
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
  /** Leader session assistant message explicitly addressed to the human via @to(user) suffix. */
  leaderUserAddressed?: boolean;
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
  containerId?: string;
  containerName?: string;
  containerImage?: string;
  name?: string;
  backendType?: BackendType;
  gitBranch?: string;
  gitAhead?: number;
  gitBehind?: number;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
  /** If this session was spawned by a cron job */
  cronJobId?: string;
  /** Human-readable name of the cron job that spawned this session */
  cronJobName?: string;
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
  /** Whether this is an orchestrator session (has takode CLI access) */
  isOrchestrator?: boolean;
  /** Session UUID of the leader that has herded this worker (single leader per session) */
  herdedBy?: string;
  /** Short integer session ID (e.g. #5), stable across restarts */
  sessionNum?: number | null;
  /** Server-authoritative attention state */
  attentionReason?: "action" | "error" | "review" | null;
  /** Epoch ms when user last viewed this session */
  lastReadAt?: number;
  /** Task history from the session auto-namer */
  taskHistory?: SessionTaskEntry[];
  /** Accumulated search keywords from the session auto-namer */
  keywords?: string[];
  /** Epoch ms of last real activity (user/assistant message, not keep_alive) */
  lastActivityAt?: number;
}
