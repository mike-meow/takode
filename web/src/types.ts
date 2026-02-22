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
} from "../server/session-types.js";
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

export type { SessionState, PermissionRequest, ContentBlock, BrowserIncomingMessage, BrowserOutgoingMessage, BackendType, McpServerDetail, McpServerConfig, CreationProgressEvent, ToolResultPreview, SessionTaskEntry, ImageRef };
export type { QuestmasterTask, QuestStatus, QuestVerificationItem, QuestFeedbackEntry, QuestImage, QuestCreateInput, QuestPatchInput, QuestTransitionInput };

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
  /** For system messages: "error" renders prominently, "denied" shows a compact denial chip, "approved" shows a green approval chip, "quest_claimed" shows collapsible quest details, default renders as subtle divider */
  variant?: "error" | "info" | "denied" | "approved" | "quest_claimed";
  /** Extra structured data for rich rendering (e.g. AskUserQuestion answers, quest claim details) */
  metadata?: {
    answers?: { question: string; answer: string }[];
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
  /** Assistant message UUID from CLI, for revert support */
  cliUuid?: string;
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
  /** Server-authoritative attention state */
  attentionReason?: "action" | "error" | "review" | null;
  /** Epoch ms when user last viewed this session */
  lastReadAt?: number;
  /** Task history from the session auto-namer */
  taskHistory?: SessionTaskEntry[];
  /** Accumulated search keywords from the session auto-namer */
  keywords?: string[];
}
