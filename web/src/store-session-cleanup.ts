import type { AppState } from "./store-types.js";
import { scopedRemoveItem, scopedSetItem } from "./utils/scoped-storage.js";

export function removeSessionState(s: AppState, sessionId: string): Partial<AppState> {
  const sessions = new Map(s.sessions);
  sessions.delete(sessionId);
  const messages = new Map(s.messages);
  messages.delete(sessionId);
  const messageFrozenCounts = new Map(s.messageFrozenCounts);
  messageFrozenCounts.delete(sessionId);
  const messageFrozenHashes = new Map(s.messageFrozenHashes);
  messageFrozenHashes.delete(sessionId);
  const messageFrozenRevisions = new Map(s.messageFrozenRevisions);
  messageFrozenRevisions.delete(sessionId);
  const historyLoading = new Map(s.historyLoading);
  historyLoading.delete(sessionId);
  const historyWindows = new Map(s.historyWindows);
  historyWindows.delete(sessionId);
  const threadWindows = new Map(s.threadWindows);
  threadWindows.delete(sessionId);
  const threadWindowMessages = new Map(s.threadWindowMessages);
  threadWindowMessages.delete(sessionId);
  const leaderProjections = new Map(s.leaderProjections);
  leaderProjections.delete(sessionId);
  const streaming = new Map(s.streaming);
  streaming.delete(sessionId);
  const streamingByParentToolUseId = new Map(s.streamingByParentToolUseId);
  streamingByParentToolUseId.delete(sessionId);
  const streamingThinking = new Map(s.streamingThinking);
  streamingThinking.delete(sessionId);
  const streamingThinkingByParentToolUseId = new Map(s.streamingThinkingByParentToolUseId);
  streamingThinkingByParentToolUseId.delete(sessionId);
  const streamingStartedAt = new Map(s.streamingStartedAt);
  streamingStartedAt.delete(sessionId);
  const streamingOutputTokens = new Map(s.streamingOutputTokens);
  streamingOutputTokens.delete(sessionId);
  const streamingPausedDuration = new Map(s.streamingPausedDuration);
  streamingPausedDuration.delete(sessionId);
  const streamingPauseStartedAt = new Map(s.streamingPauseStartedAt);
  streamingPauseStartedAt.delete(sessionId);
  const connectionStatus = new Map(s.connectionStatus);
  connectionStatus.delete(sessionId);
  const cliConnected = new Map(s.cliConnected);
  cliConnected.delete(sessionId);
  const cliEverConnected = new Map(s.cliEverConnected);
  cliEverConnected.delete(sessionId);
  const cliDisconnectReason = new Map(s.cliDisconnectReason);
  cliDisconnectReason.delete(sessionId);
  const sessionStatus = new Map(s.sessionStatus);
  sessionStatus.delete(sessionId);
  const activeTurnRoutes = new Map(s.activeTurnRoutes);
  activeTurnRoutes.delete(sessionId);
  const sessionStuck = new Map(s.sessionStuck);
  sessionStuck.delete(sessionId);
  const previousPermissionMode = new Map(s.previousPermissionMode);
  previousPermissionMode.delete(sessionId);
  const askPermission = new Map(s.askPermission);
  askPermission.delete(sessionId);
  const pendingPermissions = new Map(s.pendingPermissions);
  pendingPermissions.delete(sessionId);
  const sessionTasks = new Map(s.sessionTasks);
  sessionTasks.delete(sessionId);
  const sessionTimers = new Map(s.sessionTimers);
  sessionTimers.delete(sessionId);
  const sessionNotifications = new Map(s.sessionNotifications);
  sessionNotifications.delete(sessionId);
  const sessionAttentionRecords = new Map(s.sessionAttentionRecords);
  sessionAttentionRecords.delete(sessionId);
  const changedFiles = new Map(s.changedFiles);
  changedFiles.delete(sessionId);
  const diffFileStats = new Map(s.diffFileStats);
  diffFileStats.delete(sessionId);
  const sessionNames = new Map(s.sessionNames);
  sessionNames.delete(sessionId);
  const recentlyRenamed = new Set(s.recentlyRenamed);
  recentlyRenamed.delete(sessionId);
  const sessionPreviews = new Map(s.sessionPreviews);
  sessionPreviews.delete(sessionId);
  const sessionTaskHistory = new Map(s.sessionTaskHistory);
  sessionTaskHistory.delete(sessionId);
  const pendingCodexInputs = new Map(s.pendingCodexInputs);
  pendingCodexInputs.delete(sessionId);
  const sessionKeywords = new Map(s.sessionKeywords);
  sessionKeywords.delete(sessionId);
  const scrollToTurnId = new Map(s.scrollToTurnId);
  scrollToTurnId.delete(sessionId);
  const diffPanelSelectedFile = new Map(s.diffPanelSelectedFile);
  diffPanelSelectedFile.delete(sessionId);
  const mcpServers = new Map(s.mcpServers);
  mcpServers.delete(sessionId);
  const toolProgress = new Map(s.toolProgress);
  toolProgress.delete(sessionId);
  const toolResults = new Map(s.toolResults);
  toolResults.delete(sessionId);
  const backgroundAgentNotifs = new Map(s.backgroundAgentNotifs);
  backgroundAgentNotifs.delete(sessionId);
  const toolStartTimestamps = new Map(s.toolStartTimestamps);
  toolStartTimestamps.delete(sessionId);
  const prStatus = new Map(s.prStatus);
  prStatus.delete(sessionId);
  const feedScrollPosition = new Map(s.feedScrollPosition);
  feedScrollPosition.delete(sessionId);
  const composerDrafts = new Map(s.composerDrafts);
  composerDrafts.delete(sessionId);
  const replyContexts = new Map(s.replyContexts);
  replyContexts.delete(sessionId);
  const turnActivityOverrides = new Map(s.turnActivityOverrides);
  turnActivityOverrides.delete(sessionId);
  const autoExpandedTurnIds = new Map(s.autoExpandedTurnIds);
  autoExpandedTurnIds.delete(sessionId);
  const collapsibleTurnIds = new Map(s.collapsibleTurnIds);
  collapsibleTurnIds.delete(sessionId);
  const sessionAttention = new Map(s.sessionAttention);
  sessionAttention.delete(sessionId);
  const sessionInfoOpenSessionId = s.sessionInfoOpenSessionId === sessionId ? null : s.sessionInfoOpenSessionId;

  scopedSetItem("cc-session-names", JSON.stringify(Array.from(sessionNames.entries())));
  if (s.currentSessionId === sessionId) {
    scopedRemoveItem("cc-current-session");
  }

  return {
    sessions,
    messages,
    messageFrozenCounts,
    messageFrozenHashes,
    messageFrozenRevisions,
    historyLoading,
    historyWindows,
    threadWindows,
    threadWindowMessages,
    leaderProjections,
    streaming,
    streamingByParentToolUseId,
    streamingThinking,
    streamingThinkingByParentToolUseId,
    streamingStartedAt,
    streamingOutputTokens,
    streamingPausedDuration,
    streamingPauseStartedAt,
    connectionStatus,
    cliConnected,
    cliEverConnected,
    cliDisconnectReason,
    sessionStatus,
    activeTurnRoutes,
    sessionStuck,
    previousPermissionMode,
    askPermission,
    pendingPermissions,
    sessionTasks,
    sessionTimers,
    sessionNotifications,
    sessionAttentionRecords,
    changedFiles,
    diffFileStats,
    sessionNames,
    recentlyRenamed,
    sessionPreviews,
    sessionTaskHistory,
    pendingCodexInputs,
    sessionKeywords,
    scrollToTurnId,
    diffPanelSelectedFile,
    mcpServers,
    toolProgress,
    toolResults,
    backgroundAgentNotifs,
    toolStartTimestamps,
    prStatus,
    feedScrollPosition,
    composerDrafts,
    replyContexts,
    turnActivityOverrides,
    autoExpandedTurnIds,
    collapsibleTurnIds,
    sessionAttention,
    sessionInfoOpenSessionId,
    sdkSessions: s.sdkSessions.filter((sdk) => sdk.sessionId !== sessionId),
    currentSessionId: s.currentSessionId === sessionId ? null : s.currentSessionId,
  };
}
