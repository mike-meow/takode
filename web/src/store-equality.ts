import type { QuestmasterTask, SdkSessionInfo, SessionTaskEntry } from "./types.js";

export function stringArrayEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function sessionTaskHistoryEqual(a: SessionTaskEntry[] | undefined, b: SessionTaskEntry[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (
      left.title !== right.title ||
      left.action !== right.action ||
      left.timestamp !== right.timestamp ||
      left.triggerMessageId !== right.triggerMessageId ||
      left.source !== right.source ||
      left.questId !== right.questId
    ) {
      return false;
    }
  }
  return true;
}

function codexTokenDetailsEqual(
  a: SdkSessionInfo["codexTokenDetails"] | undefined,
  b: SdkSessionInfo["codexTokenDetails"] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  return (
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.cachedInputTokens === b.cachedInputTokens &&
    a.reasoningOutputTokens === b.reasoningOutputTokens &&
    a.modelContextWindow === b.modelContextWindow
  );
}

function claudeTokenDetailsEqual(
  a: SdkSessionInfo["claudeTokenDetails"] | undefined,
  b: SdkSessionInfo["claudeTokenDetails"] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  return (
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.cachedInputTokens === b.cachedInputTokens &&
    a.modelContextWindow === b.modelContextWindow
  );
}

function questSnapshotKey(quest: QuestmasterTask): string {
  return `${quest.id}:${quest.version}:${(quest as { updatedAt?: number }).updatedAt ?? ""}`;
}

export function reconcileQuestList(prev: QuestmasterTask[], next: QuestmasterTask[]): QuestmasterTask[] {
  if (prev.length === 0 && next.length === 0) return prev;
  if (prev.length === 0 || next.length === 0) return next;

  const prevByQuestId = new Map(prev.map((quest) => [quest.questId, quest]));
  let changed = prev.length !== next.length;
  const reconciled = next.map((quest, index) => {
    const existing = prevByQuestId.get(quest.questId);
    if (!existing || questSnapshotKey(existing) !== questSnapshotKey(quest)) {
      changed = true;
      return quest;
    }
    if (prev[index] !== existing) changed = true;
    return existing;
  });

  return changed ? reconciled : prev;
}

function sdkSessionInfoEqual(a: SdkSessionInfo, b: SdkSessionInfo): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.pid === b.pid &&
    a.state === b.state &&
    a.exitCode === b.exitCode &&
    a.model === b.model &&
    a.permissionMode === b.permissionMode &&
    a.cwd === b.cwd &&
    a.createdAt === b.createdAt &&
    a.cliSessionId === b.cliSessionId &&
    a.archived === b.archived &&
    a.archivedAt === b.archivedAt &&
    a.worktreeCleanupStatus === b.worktreeCleanupStatus &&
    a.worktreeCleanupError === b.worktreeCleanupError &&
    a.worktreeCleanupStartedAt === b.worktreeCleanupStartedAt &&
    a.worktreeCleanupFinishedAt === b.worktreeCleanupFinishedAt &&
    a.containerId === b.containerId &&
    a.containerName === b.containerName &&
    a.containerImage === b.containerImage &&
    a.name === b.name &&
    a.backendType === b.backendType &&
    a.gitBranch === b.gitBranch &&
    a.gitDefaultBranch === b.gitDefaultBranch &&
    a.diffBaseBranch === b.diffBaseBranch &&
    a.gitAhead === b.gitAhead &&
    a.gitBehind === b.gitBehind &&
    a.totalLinesAdded === b.totalLinesAdded &&
    a.totalLinesRemoved === b.totalLinesRemoved &&
    a.cronJobId === b.cronJobId &&
    a.cronJobName === b.cronJobName &&
    a.pendingTimerCount === b.pendingTimerCount &&
    a.lastMessagePreview === b.lastMessagePreview &&
    a.cliConnected === b.cliConnected &&
    a.isWorktree === b.isWorktree &&
    a.repoRoot === b.repoRoot &&
    a.worktreeExists === b.worktreeExists &&
    a.worktreeDirty === b.worktreeDirty &&
    a.isAssistant === b.isAssistant &&
    a.isOrchestrator === b.isOrchestrator &&
    a.herdedBy === b.herdedBy &&
    a.sessionNum === b.sessionNum &&
    a.attentionReason === b.attentionReason &&
    a.lastReadAt === b.lastReadAt &&
    a.pendingPermissionCount === b.pendingPermissionCount &&
    a.pendingPermissionSummary === b.pendingPermissionSummary &&
    a.lastActivityAt === b.lastActivityAt &&
    a.lastUserMessageAt === b.lastUserMessageAt &&
    a.contextUsedPercent === b.contextUsedPercent &&
    a.numTurns === b.numTurns &&
    a.messageHistoryBytes === b.messageHistoryBytes &&
    a.codexRetainedPayloadBytes === b.codexRetainedPayloadBytes &&
    a.injectedSystemPrompt === b.injectedSystemPrompt &&
    a.reviewerOf === b.reviewerOf &&
    codexTokenDetailsEqual(a.codexTokenDetails, b.codexTokenDetails) &&
    claudeTokenDetailsEqual(a.claudeTokenDetails, b.claudeTokenDetails)
  );
}

export function sdkSessionListEqual(a: SdkSessionInfo[], b: SdkSessionInfo[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!sdkSessionInfoEqual(a[i]!, b[i]!)) return false;
  }
  return true;
}
