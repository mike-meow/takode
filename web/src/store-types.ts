import type { PRStatusResponse, CreateSessionOpts, CreationProgressEvent } from "./api.js";
import type { BoardRowData } from "./components/BoardTable.js";
import type { SearchMatch, SessionSearchCategory, SessionSearchState } from "./store-session-search.js";
import type { ReplyContext } from "../shared/reply-context.js";
import type { FeedWindowSync } from "../shared/feed-window-sync.js";
import type {
  BoardRowSessionStatus,
  ChatMessage,
  ComposerDraftImage,
  HistoryWindowState,
  LeaderProjectionSnapshot,
  McpServerDetail,
  PendingCodexInput,
  PendingUserUpload,
  PermissionRequest,
  QuestmasterTask,
  SdkSessionInfo,
  SessionTaskEntry,
  SessionState,
  ActiveTurnRoute,
  TaskItem,
  ToolResultPreview,
  ThreadWindowState,
  VsCodeSelectionState,
} from "./types.js";

export interface PendingSession {
  id: string;
  backend: "claude" | "codex" | "claude-sdk";
  createOpts: CreateSessionOpts;
  progress: CreationProgressEvent[];
  error: string | null;
  status: "creating" | "error" | "succeeded";
  realSessionId: string | null;
  cwd: string | null;
  groupKey?: string | null;
  treeGroupId?: string | null;
  recentDirsKey?: string | null;
  createdAt: number;
}

export interface AppState {
  sessions: Map<string, SessionState>;
  sdkSessions: SdkSessionInfo[];
  currentSessionId: string | null;
  messages: Map<string, ChatMessage[]>;
  messageFrozenCounts: Map<string, number>;
  messageFrozenHashes: Map<string, string>;
  messageFrozenRevisions: Map<string, number>;
  historyLoading: Map<string, boolean>;
  historyWindows: Map<string, HistoryWindowState>;
  threadWindows: Map<string, Map<string, ThreadWindowState>>;
  threadWindowMessages: Map<string, Map<string, ChatMessage[]>>;
  feedWindowSyncs: Map<string, FeedWindowSync>;
  threadFeedWindowSyncs: Map<string, Map<string, FeedWindowSync>>;
  leaderProjections: Map<string, LeaderProjectionSnapshot>;
  setLeaderProjection: (sessionId: string, projection: LeaderProjectionSnapshot | null) => void;
  streaming: Map<string, string>;
  streamingByParentToolUseId: Map<string, Map<string, string>>;
  streamingThinking: Map<string, string>;
  streamingThinkingByParentToolUseId: Map<string, Map<string, string>>;
  streamingStartedAt: Map<string, number>;
  streamingOutputTokens: Map<string, number>;
  streamingPausedDuration: Map<string, number>;
  streamingPauseStartedAt: Map<string, number>;
  pendingPermissions: Map<string, Map<string, PermissionRequest>>;
  connectionStatus: Map<string, "connecting" | "connected" | "disconnected">;
  cliConnected: Map<string, boolean>;
  cliEverConnected: Map<string, boolean>;
  cliDisconnectReason: Map<string, "idle_limit" | "broken" | null>;
  sessionStatus: Map<string, "idle" | "running" | "compacting" | "reverting" | null>;
  activeTurnRoutes: Map<string, ActiveTurnRoute | null>;
  sessionStuck: Map<string, boolean>;
  previousPermissionMode: Map<string, string>;
  askPermission: Map<string, boolean>;
  sessionTasks: Map<string, TaskItem[]>;
  sessionTimers: Map<string, import("./types.js").SessionTimer[]>;
  setSessionTimers: (sessionId: string, timers: import("./types.js").SessionTimer[]) => void;
  sessionNotifications: Map<string, import("./types.js").SessionNotification[]>;
  setSessionNotifications: (sessionId: string, notifications: import("./types.js").SessionNotification[]) => void;
  sessionAttentionRecords: Map<string, import("./types.js").SessionAttentionRecord[]>;
  setSessionAttentionRecords: (sessionId: string, records: import("./types.js").SessionAttentionRecord[]) => void;
  changedFiles: Map<string, Set<string>>;
  diffFileStats: Map<string, Map<string, { additions: number; deletions: number }>>;
  sessionNames: Map<string, string>;
  recentlyRenamed: Set<string>;
  questNamedSessions: Set<string>;
  sessionPreviews: Map<string, string>;
  sessionPreviewUpdatedAt: Map<string, number>;
  sessionTaskHistory: Map<string, SessionTaskEntry[]>;
  pendingCodexInputs: Map<string, PendingCodexInput[]>;
  sessionKeywords: Map<string, string[]>;
  sessionSearch: Map<string, SessionSearchState>;
  scrollToTurnId: Map<string, string | null>;
  scrollToMessageId: Map<string, string | null>;
  expandAllInTurn: Map<string, string | null>;
  pendingScrollToMessageIndex: Map<string, number>;
  pendingScrollToMessageId: Map<string, string>;
  bottomAlignNextUserMessage: Set<string>;
  activeTaskTurnId: Map<string, string | null>;
  sessionTaskPreview: Map<string, { text: string; updatedAt: number }>;
  prStatus: Map<string, PRStatusResponse>;
  mcpServers: Map<string, McpServerDetail[]>;
  toolProgress: Map<
    string,
    Map<string, { toolName: string; elapsedSeconds: number; output?: string; outputTruncated?: boolean }>
  >;
  toolResults: Map<string, Map<string, ToolResultPreview>>;
  latestBoardToolUseId: Map<string, string>;
  setLatestBoardToolUseId: (sessionId: string, toolUseId: string) => void;
  sessionBoards: Map<string, BoardRowData[]>;
  setSessionBoard: (sessionId: string, board: BoardRowData[]) => void;
  sessionBoardRowStatuses: Map<string, Record<string, BoardRowSessionStatus>>;
  setSessionBoardRowStatuses: (sessionId: string, statuses: Record<string, BoardRowSessionStatus>) => void;
  sessionCompletedBoards: Map<string, BoardRowData[]>;
  setSessionCompletedBoard: (sessionId: string, board: BoardRowData[]) => void;
  backgroundAgentNotifs: Map<string, Map<string, { status: string; outputFile?: string; summary?: string }>>;
  setBackgroundAgentNotif: (
    sessionId: string,
    toolUseId: string,
    notif: { status: string; outputFile?: string; summary?: string },
  ) => void;
  toolStartTimestamps: Map<string, Map<string, number>>;
  sessionAttention: Map<string, "action" | "error" | "review" | null>;
  treeGroups: import("./types.js").TreeGroup[];
  treeAssignments: Map<string, string>;
  treeNodeOrder: Map<string, string[]>;
  collapsedTreeGroups: Set<string>;
  collapsedTreeNodes: Set<string>;
  expandedHerdNodes: Set<string>;
  quests: QuestmasterTask[];
  questsLoading: boolean;
  setQuests: (quests: QuestmasterTask[]) => void;
  replaceQuest: (updated: QuestmasterTask) => void;
  refreshQuests: (opts?: { background?: boolean; force?: boolean }) => Promise<void>;
  pendingSessions: Map<string, PendingSession>;
  addPendingSession: (session: PendingSession) => void;
  updatePendingSession: (id: string, updates: Partial<PendingSession>) => void;
  addPendingProgress: (id: string, step: CreationProgressEvent) => void;
  removePendingSession: (id: string) => void;
  serverName: string;
  setServerName: (name: string) => void;
  serverReachable: boolean;
  setServerReachable: (reachable: boolean) => void;
  serverRestarting: boolean;
  setServerRestarting: (v: boolean) => void;
  colorTheme: "light" | "dark" | "vscode-dark";
  darkMode: boolean;
  zoomLevel: number;
  notificationSound: boolean;
  notificationDesktop: boolean;
  showUsageBars: boolean;
  shortcutSettings: import("./shortcuts.js").ShortcutSettings;
  sidebarOpen: boolean;
  sessionInfoOpenSessionId: string | null;
  reorderMode: boolean;
  sessionSortMode: "created" | "activity";
  setSessionSortMode: (mode: "created" | "activity") => void;
  taskPanelOpen: boolean;
  searchPreviewSessionId: string | null;
  newSessionModalState: {
    groupKey?: string;
    cwd?: string;
    treeGroupId?: string;
    newSessionDefaultsKey?: string;
  } | null;
  questOverlayId: string | null;
  questOverlaySearchHighlight: string | null;
  questmasterSearchQuery: string;
  questmasterSelectedTags: string[];
  questmasterViewMode: import("./api.js").QuestmasterViewMode | null;
  questmasterCompactSort: import("./api.js").QuestmasterCompactSort | null;
  setQuestmasterSearchQuery: (query: string) => void;
  setQuestmasterSelectedTags: (tags: string[]) => void;
  setQuestmasterViewMode: (mode: import("./api.js").QuestmasterViewMode) => void;
  setQuestmasterCompactSort: (sort: import("./api.js").QuestmasterCompactSort) => void;
  activeTab: "chat" | "diff";
  diffPanelSelectedFile: Map<string, string>;
  vscodeSelectionContext: VsCodeSelectionState | null;
  dismissedVsCodeSelectionKey: string | null;
  setColorTheme: (theme: "light" | "dark" | "vscode-dark") => void;
  setDarkMode: (v: boolean) => void;
  toggleDarkMode: () => void;
  setZoomLevel: (v: number) => void;
  setNotificationSound: (v: boolean) => void;
  toggleNotificationSound: () => void;
  setNotificationDesktop: (v: boolean) => void;
  toggleNotificationDesktop: () => void;
  setShowUsageBars: (v: boolean) => void;
  toggleShowUsageBars: () => void;
  setShortcutsEnabled: (enabled: boolean) => void;
  setShortcutPreset: (preset: import("./shortcuts.js").ShortcutPresetId) => void;
  setShortcutOverride: (
    actionId: import("./shortcuts.js").ShortcutActionId,
    binding: string | null | undefined,
  ) => void;
  resetShortcutOverrides: () => void;
  setSidebarOpen: (v: boolean) => void;
  setSessionInfoOpenSessionId: (sessionId: string | null) => void;
  setReorderMode: (v: boolean) => void;
  setTaskPanelOpen: (open: boolean) => void;
  setSearchPreviewSessionId: (sessionId: string | null) => void;
  openNewSessionModal: (opts?: {
    groupKey?: string;
    cwd?: string;
    treeGroupId?: string;
    newSessionDefaultsKey?: string;
  }) => void;
  closeNewSessionModal: () => void;
  openQuestOverlay: (questId: string, searchHighlight?: string) => void;
  closeQuestOverlay: () => void;
  setVsCodeSelectionContext: (context: VsCodeSelectionState | null) => void;
  dismissVsCodeSelection: (key: string | null) => void;
  newSession: () => void;
  setCurrentSession: (id: string | null) => void;
  addSession: (session: SessionState) => void;
  updateSession: (sessionId: string, updates: Partial<SessionState>) => void;
  updateSdkSession: (sessionId: string, updates: Partial<SdkSessionInfo>) => void;
  removeSession: (sessionId: string) => void;
  setSdkSessions: (sessions: SdkSessionInfo[]) => void;
  appendMessage: (sessionId: string, msg: ChatMessage) => void;
  setMessages: (
    sessionId: string,
    msgs: ChatMessage[],
    options?: { frozenCount?: number; frozenHash?: string },
  ) => void;
  setHistoryLoading: (sessionId: string, loading: boolean) => void;
  setHistoryWindow: (sessionId: string, window: HistoryWindowState | null) => void;
  setThreadWindow: (
    sessionId: string,
    threadKey: string,
    window: ThreadWindowState | null,
    messages?: ChatMessage[],
  ) => void;
  setFeedWindowSync: (sessionId: string, sync: FeedWindowSync | null) => void;
  setPendingCodexInputs: (sessionId: string, inputs: PendingCodexInput[]) => void;
  updateMessage: (sessionId: string, msgId: string, updates: Partial<ChatMessage>) => void;
  updateQuestTitleInMessages: (sessionId: string, questId: string, newTitle: string) => void;
  updateLastAssistantMessage: (sessionId: string, updater: (msg: ChatMessage) => ChatMessage) => void;
  commitMessagesAsFrozen: (sessionId: string) => void;
  setStreaming: (sessionId: string, text: string | null, parentToolUseId?: string | null) => void;
  setStreamingThinking: (sessionId: string, text: string | null, parentToolUseId?: string | null) => void;
  setStreamingStats: (sessionId: string, stats: { startedAt?: number; outputTokens?: number } | null) => void;
  clearStreamingState: (sessionId: string) => void;
  resetSessionForAuthoritativeHistory: (
    sessionId: string,
    options?: { preserveToolStateIds?: Iterable<string> },
  ) => void;
  addPermission: (sessionId: string, perm: PermissionRequest) => void;
  removePermission: (sessionId: string, requestId: string) => void;
  updatePermissionEvaluating: (
    sessionId: string,
    requestId: string,
    evaluating: "queued" | "evaluating" | undefined,
  ) => void;
  updatePermissionDeferralReason: (sessionId: string, requestId: string, reason: string) => void;
  markPermissionAutoApproved: (sessionId: string, requestId: string, reason: string) => void;
  clearPermissions: (sessionId: string) => void;
  pauseStreamingTimer: (sessionId: string) => void;
  resumeStreamingTimer: (sessionId: string) => void;
  addTask: (sessionId: string, task: TaskItem) => void;
  setTasks: (sessionId: string, tasks: TaskItem[]) => void;
  updateTask: (sessionId: string, taskId: string, updates: Partial<TaskItem>) => void;
  addChangedFile: (sessionId: string, filePath: string) => void;
  clearChangedFiles: (sessionId: string) => void;
  setDiffFileStats: (sessionId: string, stats: Map<string, { additions: number; deletions: number }>) => void;
  setSessionName: (sessionId: string, name: string) => void;
  markRecentlyRenamed: (sessionId: string) => void;
  clearRecentlyRenamed: (sessionId: string) => void;
  markQuestNamed: (sessionId: string) => void;
  clearQuestNamed: (sessionId: string) => void;
  setSessionPreview: (sessionId: string, preview: string) => void;
  setSessionTaskPreview: (sessionId: string, text: string | null) => void;
  setSessionTaskHistory: (sessionId: string, tasks: SessionTaskEntry[]) => void;
  setSessionKeywords: (sessionId: string, keywords: string[]) => void;
  requestScrollToTurn: (sessionId: string, turnId: string) => void;
  clearScrollToTurn: (sessionId: string) => void;
  requestScrollToMessage: (sessionId: string, messageId: string) => void;
  clearScrollToMessage: (sessionId: string) => void;
  setExpandAllInTurn: (sessionId: string, messageId: string) => void;
  clearExpandAllInTurn: (sessionId: string) => void;
  setPendingScrollToMessageIndex: (sessionId: string, messageIndex: number) => void;
  clearPendingScrollToMessageIndex: (sessionId: string) => void;
  setPendingScrollToMessageId: (sessionId: string, messageId: string) => void;
  clearPendingScrollToMessageId: (sessionId: string) => void;
  openSessionSearch: (sessionId: string) => void;
  closeSessionSearch: (sessionId: string) => void;
  setSessionSearchQuery: (sessionId: string, query: string) => void;
  setSessionSearchResults: (sessionId: string, matches: SearchMatch[]) => void;
  setSessionSearchMode: (sessionId: string, mode: "strict" | "fuzzy") => void;
  setSessionSearchCategory: (sessionId: string, category: SessionSearchCategory) => void;
  navigateSessionSearch: (sessionId: string, direction: "next" | "prev") => void;
  requestBottomAlignOnNextUserMessage: (sessionId: string) => void;
  clearBottomAlignOnNextUserMessage: (sessionId: string) => void;
  setActiveTaskTurnId: (sessionId: string, turnId: string | null) => void;
  setPRStatus: (sessionId: string, status: PRStatusResponse) => void;
  setMcpServers: (sessionId: string, servers: McpServerDetail[]) => void;
  setToolProgress: (
    sessionId: string,
    toolUseId: string,
    data: { toolName: string; elapsedSeconds: number; outputDelta?: string },
  ) => void;
  clearToolProgress: (sessionId: string, toolUseId?: string) => void;
  setToolResult: (sessionId: string, toolUseId: string, preview: ToolResultPreview) => void;
  setToolStartTimestamps: (sessionId: string, timestamps: Record<string, number>) => void;
  markSessionViewed: (sessionId: string) => void;
  markSessionUnread: (sessionId: string) => void;
  markAllSessionsViewed: () => void;
  clearSessionAttention: (sessionId: string) => void;
  setTreeGroups: (
    groups: import("./types.js").TreeGroup[],
    assignments: Record<string, string>,
    nodeOrder: Record<string, string[]>,
  ) => void;
  toggleTreeGroupCollapse: (groupId: string) => void;
  toggleTreeNodeCollapse: (sessionId: string) => void;
  toggleHerdNodeExpand: (sessionId: string) => void;
  setPreviousPermissionMode: (sessionId: string, mode: string) => void;
  setAskPermission: (sessionId: string, value: boolean) => void;
  setConnectionStatus: (sessionId: string, status: "connecting" | "connected" | "disconnected") => void;
  setCliConnected: (sessionId: string, connected: boolean) => void;
  setCliEverConnected: (sessionId: string) => void;
  setCliDisconnectReason: (sessionId: string, reason: "idle_limit" | "broken" | null) => void;
  setSessionStatus: (sessionId: string, status: "idle" | "running" | "compacting" | "reverting" | null) => void;
  setActiveTurnRoute: (sessionId: string, route: ActiveTurnRoute | null | undefined) => void;
  setSessionStuck: (sessionId: string, stuck: boolean) => void;
  feedScrollPosition: Map<
    string,
    {
      scrollTop: number;
      scrollHeight: number;
      isAtBottom: boolean;
      anchorTurnId?: string | null;
      anchorOffsetTop?: number;
      lastSeenContentBottom?: number | null;
    }
  >;
  setFeedScrollPosition: (
    sessionId: string,
    pos: {
      scrollTop: number;
      scrollHeight: number;
      isAtBottom: boolean;
      anchorTurnId?: string | null;
      anchorOffsetTop?: number;
      lastSeenContentBottom?: number | null;
    },
  ) => void;
  composerDrafts: Map<string, { text: string; images: ComposerDraftImage[] }>;
  setComposerDraft: (sessionId: string, draft: { text: string; images: ComposerDraftImage[] }) => void;
  clearComposerDraft: (sessionId: string) => void;
  pendingUserUploads: Map<string, PendingUserUpload[]>;
  pendingUserUploadRestorations: Map<string, Map<string, PendingUserUpload>>;
  addPendingUserUpload: (sessionId: string, upload: PendingUserUpload) => void;
  updatePendingUserUpload: (
    sessionId: string,
    uploadId: string,
    updater: (upload: PendingUserUpload) => PendingUserUpload,
  ) => void;
  removePendingUserUpload: (sessionId: string, uploadId: string) => void;
  consumePendingUserUpload: (sessionId: string, uploadId: string) => PendingUserUpload | null;
  getPendingUserUploadRestoration: (sessionId: string, uploadId: string) => PendingUserUpload | null;
  replyContexts: Map<string, ReplyContext>;
  setReplyContext: (sessionId: string, context: ReplyContext | null) => void;
  focusComposerTrigger: number;
  focusComposer: () => void;
  turnActivityOverrides: Map<string, Map<string, boolean>>;
  autoExpandedTurnIds: Map<string, Set<string>>;
  collapsibleTurnIds: Map<string, string[]>;
  toggleTurnActivity: (sessionId: string, turnId: string, defaultExpanded: boolean) => void;
  collapseAllTurnActivity: (sessionId: string, turnIds: string[]) => void;
  focusTurn: (sessionId: string, targetTurnId: string) => void;
  keepTurnExpanded: (sessionId: string, turnId: string) => void;
  keepTurnAutoExpanded: (sessionId: string, turnId: string) => void;
  clearAutoExpandedTurns: (sessionId: string) => void;
  setCollapsibleTurnIds: (sessionId: string, turnIds: string[]) => void;
  setActiveTab: (tab: "chat" | "diff") => void;
  setDiffPanelSelectedFile: (sessionId: string, filePath: string | null) => void;
  terminalOpen: boolean;
  terminalCwd: string | null;
  terminalSessionId: string | null;
  terminalId: string | null;
  setTerminalOpen: (open: boolean) => void;
  setTerminalCwd: (cwd: string | null) => void;
  setTerminalSessionId: (sessionId: string | null) => void;
  setTerminalId: (id: string | null) => void;
  openTerminal: (cwd: string, sessionId?: string | null) => void;
  closeTerminal: () => void;
  reset: () => void;
}
