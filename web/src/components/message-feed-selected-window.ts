export interface MissingSelectedThreadWindowContextInput {
  selectedFeedWindowEnabled: boolean;
  hasActiveThreadWindow: boolean;
  historyLoading: boolean;
  messageCount: number;
  frozenCount: number;
  historyWindowTotalTurns: number;
  leaderProjectionSourceHistoryLength: number;
}

export function hasMissingSelectedThreadWindowContext({
  selectedFeedWindowEnabled,
  hasActiveThreadWindow,
  historyLoading,
  messageCount,
  frozenCount,
  historyWindowTotalTurns,
  leaderProjectionSourceHistoryLength,
}: MissingSelectedThreadWindowContextInput): boolean {
  return (
    selectedFeedWindowEnabled &&
    !hasActiveThreadWindow &&
    (historyLoading ||
      messageCount > 0 ||
      frozenCount > 0 ||
      historyWindowTotalTurns > 0 ||
      leaderProjectionSourceHistoryLength > 0)
  );
}

export interface SelectedThreadWindowLoadingInput {
  messageCount: number;
  pendingUserUploadCount: number;
  pendingCodexInputCount: number;
  hasStreamingText: boolean;
  selectedFeedWindowEnabled: boolean;
  hasActiveThreadWindow: boolean;
  missingSelectedWindowHasContext: boolean;
  pendingInitialThreadWindowKey: string | null;
  normalizedThreadKey: string;
}

export function shouldShowSelectedThreadWindowLoading({
  messageCount,
  pendingUserUploadCount,
  pendingCodexInputCount,
  hasStreamingText,
  selectedFeedWindowEnabled,
  hasActiveThreadWindow,
  missingSelectedWindowHasContext,
  pendingInitialThreadWindowKey,
  normalizedThreadKey,
}: SelectedThreadWindowLoadingInput): boolean {
  return (
    messageCount === 0 &&
    pendingUserUploadCount === 0 &&
    pendingCodexInputCount === 0 &&
    !hasStreamingText &&
    selectedFeedWindowEnabled &&
    !hasActiveThreadWindow &&
    (missingSelectedWindowHasContext || pendingInitialThreadWindowKey === normalizedThreadKey)
  );
}
