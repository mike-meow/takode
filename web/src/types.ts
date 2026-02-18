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
} from "../server/session-types.js";

export type { SessionState, PermissionRequest, ContentBlock, BrowserIncomingMessage, BrowserOutgoingMessage, BackendType, McpServerDetail, McpServerConfig, CreationProgressEvent, ToolResultPreview };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  contentBlocks?: ContentBlock[];
  images?: { media_type: string; data: string }[];
  timestamp: number;
  parentToolUseId?: string | null;
  isStreaming?: boolean;
  model?: string;
  stopReason?: string | null;
  /** For system messages: "error" renders prominently, "denied" shows a compact denial chip, "approved" shows a green approval chip, default renders as subtle divider */
  variant?: "error" | "info" | "denied" | "approved";
  /** Extra structured data for rich rendering (e.g. AskUserQuestion answers) */
  metadata?: { answers?: { question: string; answer: string }[] };
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
}
