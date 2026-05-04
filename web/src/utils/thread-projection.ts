import type {
  ChatMessage,
  SessionNotification,
  ThreadAttachmentMarker,
  ThreadAttachmentMovementSummary,
  ThreadTransitionMarker,
} from "../types.js";
import {
  inferThreadTargetFromTextContent,
  isQuestThreadKey,
  normalizeThreadTarget,
} from "../../shared/thread-routing.js";

export const MAIN_THREAD_KEY = "main";
export const ALL_THREADS_KEY = "all";

export function normalizeThreadKey(threadKey: string): string {
  return threadKey.trim().toLowerCase();
}

export function isMainThreadKey(threadKey: string): boolean {
  return normalizeThreadKey(threadKey) === MAIN_THREAD_KEY;
}

export function isAllThreadsKey(threadKey: string): boolean {
  return normalizeThreadKey(threadKey) === ALL_THREADS_KEY;
}

export function isThreadAttachmentMarkerMessage(message: ChatMessage): boolean {
  return !!message.metadata?.threadAttachmentMarker;
}

export function isThreadTransitionMarkerMessage(message: ChatMessage): boolean {
  return !!message.metadata?.threadTransitionMarker;
}

export function isCrossThreadActivityMarkerMessage(message: ChatMessage): boolean {
  return !!message.metadata?.crossThreadActivityMarker;
}

export function formatThreadAttachmentMarkerSummary(marker: ThreadAttachmentMarker): string {
  const destination = marker.questId ?? marker.threadKey;
  const countLabel = `${marker.count} message${marker.count === 1 ? "" : "s"}`;
  return `${countLabel} moved to ${destination}`;
}

export function formatThreadAttachmentMarkerDetails(marker: ThreadAttachmentMarker): string {
  const parts: string[] = [];
  if (marker.ranges.length > 0) {
    parts.push(`Ranges: ${marker.ranges.join(", ")}`);
  }
  if (marker.messageIds.length > 0) {
    parts.push(`Message ids: ${marker.messageIds.join(", ")}`);
  }
  return parts.join(" · ");
}

export function formatThreadAttachmentMarkerDetail(marker: ThreadAttachmentMarker): string {
  const destination = marker.questId ?? marker.threadKey;
  const countLabel = `${marker.count} ${marker.count === 1 ? "message" : "messages"}`;
  const details = formatThreadAttachmentMarkerDetails(marker);
  return `${countLabel} moved to thread:${destination}${details ? ` · ${details}` : ""}`;
}

export function formatThreadAttachmentMovementSummary(summary: ThreadAttachmentMovementSummary): string {
  const countLabel = `${summary.count} ${summary.count === 1 ? "message" : "messages"}`;
  return `${countLabel} moved to ${formatThreadLabel(summary.questId ?? summary.threadKey)}`;
}

export function threadAttachmentMarkerTargetKey(marker: ThreadAttachmentMarker): string {
  return normalizeThreadKey(marker.threadKey || marker.questId || "");
}

export function summarizeThreadAttachmentMarkersForThread(
  messages: ReadonlyArray<ChatMessage>,
  threadKey: string,
): ThreadAttachmentMovementSummary | null {
  const target = normalizeThreadKey(threadKey);
  if (!target || isMainThreadKey(target)) return null;

  let count = 0;
  let questId: string | undefined;
  const details: string[] = [];
  const markerIds: string[] = [];
  for (const message of messages) {
    const marker = message.metadata?.threadAttachmentMarker;
    if (!marker || threadAttachmentMarkerTargetKey(marker) !== target) continue;
    count += marker.count;
    questId ??= marker.questId;
    markerIds.push(marker.id);
    details.push(formatThreadAttachmentMarkerDetail(marker));
  }

  if (count === 0) return null;
  return { threadKey: target, ...(questId ? { questId } : {}), count, details, markerIds };
}

export function formatThreadTransitionMarkerSummary(marker: ThreadTransitionMarker): string {
  const source = formatThreadLabel(marker.sourceQuestId ?? marker.sourceThreadKey);
  const destination = formatThreadLabel(marker.questId ?? marker.threadKey);
  return `Work continued from ${source} to ${destination}`;
}

function normalizedRouteKeys(message: ChatMessage): Set<string> {
  const keys = new Set<string>();
  const add = (value: string | undefined) => {
    if (!value) return;
    const normalized = normalizeThreadKey(value);
    if (!normalized || normalized === MAIN_THREAD_KEY) return;
    keys.add(normalized);
  };

  const metadata = message.metadata;
  add(metadata?.threadKey);
  add(metadata?.questId);
  for (const ref of metadata?.threadRefs ?? []) {
    add(ref.threadKey);
    add(ref.questId);
  }
  const inferred = inferredHerdEventRoute(message);
  add(inferred?.threadKey);
  add(inferred?.questId);
  return keys;
}

function messageHasThreadRef(message: ChatMessage, threadKey: string): boolean {
  if (isThreadAttachmentMarkerMessage(message) || isThreadTransitionMarkerMessage(message)) return false;
  return normalizedRouteKeys(message).has(normalizeThreadKey(threadKey));
}

export function recoverRoutedNotificationSourceMessages(
  messages: ChatMessage[],
  notifications: ReadonlyArray<SessionNotification> | undefined,
  threadKey: string,
): ChatMessage[] {
  const normalizedThreadKey = normalizeThreadKey(threadKey);
  if (isMainThreadKey(normalizedThreadKey) || isAllThreadsKey(normalizedThreadKey) || !notifications?.length) {
    return messages;
  }

  const sourceRoutes = notificationSourceRoutesByMessageId(notifications, normalizedThreadKey);
  if (sourceRoutes.size === 0) return messages;

  let changed = false;
  const recovered = messages.map((message) => {
    const route = sourceRoutes.get(message.id);
    if (!route || messageHasThreadRef(message, route.threadKey)) return message;
    changed = true;
    return {
      ...message,
      metadata: {
        ...message.metadata,
        threadRefs: [
          ...(message.metadata?.threadRefs ?? []),
          {
            threadKey: route.threadKey,
            ...(route.questId ? { questId: route.questId } : {}),
            source: "inferred" as const,
          },
        ],
      },
    };
  });

  return changed ? recovered : messages;
}

export function collectRetainedNotificationSourceMessageIds(
  notifications: ReadonlyArray<SessionNotification> | undefined,
  threadKey: string,
): Set<string> {
  const normalizedThreadKey = normalizeThreadKey(threadKey);
  if (isAllThreadsKey(normalizedThreadKey) || !notifications?.length) {
    return new Set();
  }
  if (isMainThreadKey(normalizedThreadKey)) return mainNotificationSourceMessageIds(notifications);
  return new Set(notificationSourceRoutesByMessageId(notifications, normalizedThreadKey).keys());
}

function mainNotificationSourceMessageIds(notifications: ReadonlyArray<SessionNotification>): Set<string> {
  const ids = new Set<string>();
  for (const notification of notifications) {
    if (notification.done || !notification.messageId) continue;
    if (routeFromNotification(notification)) continue;
    ids.add(notification.messageId);
  }
  return ids;
}

function notificationSourceRoutesByMessageId(
  notifications: ReadonlyArray<SessionNotification>,
  threadKey: string,
): Map<string, { threadKey: string; questId?: string }> {
  const routes = new Map<string, { threadKey: string; questId?: string }>();
  for (const notification of notifications) {
    if (notification.done || notification.category !== "needs-input" || !notification.messageId) continue;
    const route = routeFromNotification(notification);
    if (!route || route.threadKey !== threadKey) continue;
    routes.set(notification.messageId, route);
  }
  return routes;
}

function routeFromNotification(notification: SessionNotification): { threadKey: string; questId?: string } | null {
  const rawTarget =
    notification.threadKey ??
    notification.questId ??
    notification.threadRefs?.find((ref) => ref.threadKey || ref.questId)?.threadKey ??
    notification.threadRefs?.find((ref) => ref.questId)?.questId;
  if (!rawTarget) return null;
  const target = normalizeThreadTarget(rawTarget) ?? { threadKey: normalizeThreadKey(rawTarget) };
  if (!target.threadKey || isMainThreadKey(target.threadKey)) return null;
  return {
    threadKey: target.threadKey,
    ...(target.questId ? { questId: target.questId } : notification.questId ? { questId: notification.questId } : {}),
  };
}

function contentBlockToolUseId(block: NonNullable<ChatMessage["contentBlocks"]>[number]): string | null {
  if (block.type === "tool_use") return block.id;
  if (block.type === "tool_result") return block.tool_use_id;
  return null;
}

export function messageToolUseIds(message: ChatMessage): string[] {
  return (message.contentBlocks ?? []).map(contentBlockToolUseId).filter((id): id is string => Boolean(id));
}

export function collectMessageToolUseIds(messages: ChatMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const toolUseId of messageToolUseIds(message)) {
      ids.add(toolUseId);
    }
  }
  return ids;
}

function transitionMarkerSourceMatchesThread(marker: ThreadTransitionMarker, threadKey: string): boolean {
  const target = normalizeThreadKey(threadKey);
  return (
    normalizeThreadKey(marker.sourceThreadKey) === target || normalizeThreadKey(marker.sourceQuestId ?? "") === target
  );
}

function threadSystemMarkerVisibleInQuestThread(
  message: ChatMessage,
  messages: ChatMessage[],
  threadKey: string,
): boolean {
  const attachment = message.metadata?.threadAttachmentMarker;
  if (attachment) return false;
  const transition = message.metadata?.threadTransitionMarker;
  if (transition) return transitionMarkerSourceMatchesThread(transition, threadKey);
  return false;
}

function hasExplicitNonMainRoute(message: ChatMessage): boolean {
  if (isThreadAttachmentMarkerMessage(message) || isThreadTransitionMarkerMessage(message)) return false;
  const inferred = inferredHerdEventRoute(message);
  if (inferred) return true;
  const metadata = message.metadata;
  if (!metadata) return false;

  if (metadata.threadKey && !isMainThreadKey(metadata.threadKey)) return true;
  if (metadata.questId && !isMainThreadKey(metadata.questId)) return true;
  return (metadata.threadRefs ?? []).some((ref) => ref.source !== "backfill" && !isMainThreadKey(ref.threadKey));
}

function explicitNonMainRoute(message: ChatMessage): { threadKey: string; questId?: string } | null {
  const metadata = message.metadata;
  if (metadata) {
    if (metadata.threadKey && !isMainThreadKey(metadata.threadKey)) {
      return {
        threadKey: normalizeThreadKey(metadata.threadKey),
        ...(metadata.questId ? { questId: metadata.questId } : {}),
      };
    }
    if (metadata.questId && !isMainThreadKey(metadata.questId)) {
      return { threadKey: normalizeThreadKey(metadata.questId), questId: metadata.questId };
    }
    const ref = (metadata.threadRefs ?? []).find((candidate) => {
      return candidate.source !== "backfill" && !isMainThreadKey(candidate.threadKey);
    });
    if (ref) {
      return {
        threadKey: normalizeThreadKey(ref.threadKey),
        ...(ref.questId ? { questId: ref.questId } : {}),
      };
    }
  }
  return inferredHerdEventRoute(message);
}

function isHerdEventMessage(message: ChatMessage): boolean {
  return message.agentSource?.sessionId === "herd-events";
}

function inferredHerdEventRoute(message: ChatMessage): { threadKey: string; questId?: string } | null {
  if (!isHerdEventMessage(message) || typeof message.content !== "string") return null;
  const target = inferThreadTargetFromTextContent(message.content);
  if (!target || isMainThreadKey(target.threadKey)) return null;
  return {
    threadKey: normalizeThreadKey(target.threadKey),
    ...(target.questId ? { questId: target.questId } : {}),
  };
}

function buildCrossThreadActivityMarker(
  hiddenMessages: ChatMessage[],
  route: { threadKey: string; questId?: string },
): ChatMessage {
  const first = hiddenMessages[0];
  const last = hiddenMessages[hiddenMessages.length - 1] ?? first;
  const destination = route.questId ?? route.threadKey;
  const count = hiddenMessages.length;
  const countLabel = `${count} ${count === 1 ? "activity" : "activities"}`;
  return {
    id: `cross-thread-activity:${route.threadKey}:${first.id}`,
    role: "system",
    content: `${countLabel} in thread:${destination}`,
    timestamp: last.timestamp,
    ephemeral: true,
    metadata: {
      threadKey: route.threadKey,
      ...(route.questId ? { questId: route.questId } : {}),
      crossThreadActivityMarker: {
        threadKey: route.threadKey,
        ...(route.questId ? { questId: route.questId } : {}),
        count,
        firstMessageId: first.id,
        lastMessageId: last.id,
        ...(typeof first.historyIndex === "number" ? { firstHistoryIndex: first.historyIndex } : {}),
        ...(typeof last.historyIndex === "number" ? { lastHistoryIndex: last.historyIndex } : {}),
        startedAt: first.timestamp,
        updatedAt: last.timestamp,
      },
    },
  };
}

function filterMainThreadMessages(messages: ChatMessage[]): ChatMessage[] {
  const projected: ChatMessage[] = [];
  let hiddenRun: ChatMessage[] = [];
  let hiddenRunRoute: { threadKey: string; questId?: string } | null = null;

  const flushHiddenRun = () => {
    if (!hiddenRunRoute || hiddenRun.length === 0) return;
    if (!isQuestThreadKey(hiddenRunRoute.threadKey)) {
      projected.push(buildCrossThreadActivityMarker(hiddenRun, hiddenRunRoute));
    }
    hiddenRun = [];
    hiddenRunRoute = null;
  };

  for (const message of messages) {
    if (isCrossThreadActivityMarkerMessage(message)) {
      flushHiddenRun();
      projected.push(message);
      continue;
    }
    if (isThreadAttachmentMarkerMessage(message)) {
      flushHiddenRun();
      continue;
    }
    if (isThreadTransitionMarkerMessage(message)) {
      flushHiddenRun();
      if (isMainThreadKey(message.metadata?.threadTransitionMarker?.sourceThreadKey ?? "")) {
        projected.push(message);
      }
      continue;
    }
    if (!hasExplicitNonMainRoute(message)) {
      flushHiddenRun();
      projected.push(message);
      continue;
    }

    const route = explicitNonMainRoute(message);
    if (!route) continue;
    if (isHerdEventMessage(message)) continue;
    if (hiddenRunRoute && hiddenRunRoute.threadKey !== route.threadKey) {
      flushHiddenRun();
    }
    hiddenRunRoute = route;
    hiddenRun.push(message);
  }
  flushHiddenRun();
  return projected;
}

function filterQuestThreadMessages(messages: ChatMessage[], threadKey: string): ChatMessage[] {
  const includedToolUseIds = new Set<string>();
  for (const message of messages) {
    if (
      !messageHasThreadRef(message, threadKey) &&
      !threadSystemMarkerVisibleInQuestThread(message, messages, threadKey)
    ) {
      continue;
    }
    for (const toolUseId of messageToolUseIds(message)) {
      includedToolUseIds.add(toolUseId);
    }
  }

  return messages.filter((message) => {
    if (threadSystemMarkerVisibleInQuestThread(message, messages, threadKey)) return true;
    if (messageHasThreadRef(message, threadKey)) return true;
    if (message.parentToolUseId && includedToolUseIds.has(message.parentToolUseId)) return true;
    return messageToolUseIds(message).some((toolUseId) => includedToolUseIds.has(toolUseId));
  });
}

export function formatThreadLabel(threadKey: string): string {
  return isMainThreadKey(threadKey) ? "Main" : `thread:${threadKey}`;
}

export function filterMessagesForThread(messages: ChatMessage[], threadKey: string): ChatMessage[] {
  if (isAllThreadsKey(threadKey)) return messages;
  if (isMainThreadKey(threadKey)) return filterMainThreadMessages(messages);
  return filterQuestThreadMessages(messages, normalizeThreadKey(threadKey));
}
