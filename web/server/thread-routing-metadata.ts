import { inferThreadTargetFromTextContent, isQuestThreadKey, normalizeThreadTarget } from "../shared/thread-routing.js";
import type {
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  PermissionRequest,
  ThreadRef,
  ThreadTransitionMarker,
} from "./session-types.js";

export interface ThreadRouteMetadata {
  threadKey: string;
  questId?: string;
  threadRefs?: ThreadRef[];
}

export interface ThreadAttachmentSelection {
  indices: number[];
  messageIds: string[];
  ranges: string[];
  markerKey: string;
  firstMessageIndex: number;
  firstMessageId: string;
}

type ThreadedHistoryEntry = Pick<BrowserIncomingMessage, "threadKey" | "questId" | "threadRefs">;
type TextContentHistoryEntry = ThreadedHistoryEntry & { content?: string };

export function threadRouteForTarget(threadKey: string, source: ThreadRef["source"] = "explicit"): ThreadRouteMetadata {
  const target = normalizeThreadTarget(threadKey) ?? { threadKey: "main" };
  if (target.threadKey === "main") return { threadKey: "main" };
  return {
    threadKey: target.threadKey,
    questId: target.questId,
    threadRefs: [{ threadKey: target.threadKey, questId: target.questId, source }],
  };
}

export function normalizeThreadRoute(threadKey?: string | null, questId?: string | null): ThreadRouteMetadata | null {
  const target = typeof threadKey === "string" ? normalizeThreadTarget(threadKey) : null;
  const questTarget = typeof questId === "string" ? normalizeThreadTarget(questId) : null;
  const normalized = target ?? questTarget;
  if (!normalized) return null;
  return threadRouteForTarget(normalized.threadKey, "explicit");
}

export function routeKey(route?: { threadKey?: string } | null): string {
  return (route?.threadKey ?? "main").trim().toLowerCase() || "main";
}

export function sameThreadRoute(left?: { threadKey?: string } | null, right?: { threadKey?: string } | null): boolean {
  return routeKey(left) === routeKey(right);
}

export function routeFromHistoryEntry(entry: ThreadedHistoryEntry | undefined): ThreadRouteMetadata | null {
  if (!entry) return null;
  const direct = normalizeThreadRoute(entry.threadKey, entry.questId);
  if (direct) return direct;
  const firstRef = entry.threadRefs?.find((ref) => normalizeThreadTarget(ref.threadKey));
  return firstRef ? threadRouteForTarget(firstRef.threadKey, firstRef.source) : null;
}

export function inferThreadRouteFromTextContent(content: string | undefined): ThreadRouteMetadata | null {
  if (!content) return null;
  const target = inferThreadTargetFromTextContent(content);
  return target ? threadRouteForTarget(target.threadKey, "inferred") : null;
}

export function inferRouteFromHistoryEntryContent(
  entry: TextContentHistoryEntry | undefined,
): ThreadRouteMetadata | null {
  return inferThreadRouteFromTextContent(entry?.content);
}

export function inferCurrentThreadRoute(history: BrowserIncomingMessage[]): ThreadRouteMetadata {
  for (let index = history.length - 1; index >= 0; index--) {
    const route = routeFromHistoryEntry(history[index]);
    if (route) return route;
  }
  return { threadKey: "main" };
}

export function inferThreadRouteForNotificationAnchor(
  history: BrowserIncomingMessage[],
  anchorIndex: number | undefined,
): ThreadRouteMetadata {
  if (anchorIndex !== undefined) {
    const route = routeFromHistoryEntry(history[anchorIndex]);
    if (route) return route;
  }
  return inferCurrentThreadRoute(history);
}

export function resolveConsistentNotificationThreadRoute(
  history: BrowserIncomingMessage[],
  anchorIndex: number | undefined,
  notificationId: string,
): ThreadRouteMetadata {
  const inferredRoute = inferThreadRouteForNotificationAnchor(history, anchorIndex);
  const anchor = anchorIndex === undefined ? undefined : history[anchorIndex];
  const anchorRoute = routeFromHistoryEntry(anchor);

  if (anchorRoute && !sameThreadRoute(anchorRoute, inferredRoute)) {
    console.warn(
      `[notifications] Normalizing ${notificationId} to anchored message thread ${anchorRoute.threadKey}; inferred ${inferredRoute.threadKey}`,
    );
    return anchorRoute;
  }

  const threadKey = typeof anchor?.threadKey === "string" ? anchor.threadKey.trim().toLowerCase() : "";
  const questId = typeof anchor?.questId === "string" ? anchor.questId.trim().toLowerCase() : "";
  if (/^q-\d+$/.test(threadKey) && /^q-\d+$/.test(questId) && threadKey !== questId) {
    console.warn(
      `[notifications] Anchor route metadata diverged for ${notificationId}; using threadKey ${threadKey} over questId ${questId}`,
    );
  }

  return inferredRoute;
}

export function withThreadRoute<T extends object>(value: T, route: ThreadRouteMetadata): T & ThreadRouteMetadata {
  return {
    ...value,
    threadKey: route.threadKey,
    ...(route.questId ? { questId: route.questId } : {}),
    ...(route.threadRefs?.length ? { threadRefs: route.threadRefs } : {}),
  };
}

export function enrichPermissionWithThreadRoute(
  permission: PermissionRequest,
  history: BrowserIncomingMessage[],
): PermissionRequest {
  if (permission.threadKey) return permission;
  return withThreadRoute(permission, inferCurrentThreadRoute(history));
}

export function browserMessageRoute(
  msg: Pick<BrowserOutgoingMessage & { type: "user_message" }, "threadKey" | "questId">,
): ThreadRouteMetadata | null {
  return normalizeThreadRoute(msg.threadKey, msg.questId);
}

export function messageIdForThreadAttachment(entry: BrowserIncomingMessage, index: number): string {
  const direct = (entry as { id?: unknown }).id;
  if (typeof direct === "string" && direct.trim()) return direct;
  if (entry.type === "assistant" && typeof entry.message?.id === "string" && entry.message.id.trim()) {
    return entry.message.id;
  }
  if (
    (entry.type === "permission_denied" ||
      entry.type === "permission_approved" ||
      entry.type === "permission_auto_approved" ||
      entry.type === "permission_auto_denied" ||
      entry.type === "permission_needs_attention") &&
    typeof entry.request_id === "string" &&
    entry.request_id.trim()
  ) {
    return `${entry.type}:${entry.request_id}`;
  }
  return `history-index:${index}`;
}

export function buildThreadAttachmentSelection(
  history: BrowserIncomingMessage[],
  questId: string,
  indices: number[],
): ThreadAttachmentSelection {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const messageIds = sorted.map((index) => messageIdForThreadAttachment(history[index]!, index));
  return {
    indices: sorted,
    messageIds,
    ranges: compactIndexRanges(sorted),
    markerKey: `thread-attachment:${questId}:${messageIds.join(",")}`,
    firstMessageIndex: sorted[0] ?? 0,
    firstMessageId: messageIds[0] ?? "",
  };
}

export function hasThreadAttachmentMarker(history: BrowserIncomingMessage[], markerKey: string): boolean {
  return history.some((entry) => entry.type === "thread_attachment_marker" && entry.markerKey === markerKey);
}

export function inferThreadAttachmentSourceRoute(
  history: BrowserIncomingMessage[],
  destinationThreadKey: string,
  indices: number[],
): ThreadRouteMetadata | null {
  const destination = routeKey({ threadKey: destinationThreadKey });
  let sourceRoute: ThreadRouteMetadata | null = null;

  for (const index of indices) {
    const route = routeFromHistoryEntry(history[index]);
    if (!route || !isQuestThreadKey(route.threadKey) || routeKey(route) === destination) continue;
    if (sourceRoute && !sameThreadRoute(sourceRoute, route)) return null;
    sourceRoute = route;
  }

  return sourceRoute;
}

export function appendThreadTransitionMarkerForRouteSwitch(
  history: BrowserIncomingMessage[],
  destinationRoute: ThreadRouteMetadata | null | undefined,
  timestamp = Date.now(),
): ThreadTransitionMarker | null {
  if (!destinationRoute || !isQuestThreadKey(destinationRoute.threadKey)) return null;

  const source = findPreviousTransitionSourceRoute(history);
  if (!source || sameThreadRoute(source.route, destinationRoute)) return null;

  const markerKey = `thread-transition:${source.route.threadKey}->${destinationRoute.threadKey}:${source.index}`;
  if (hasThreadTransitionMarker(history, markerKey)) return null;

  const marker: ThreadTransitionMarker = {
    type: "thread_transition_marker",
    id: `thread-transition-${timestamp}-${history.length}`,
    timestamp,
    markerKey,
    sourceThreadKey: source.route.threadKey,
    ...(source.route.questId ? { sourceQuestId: source.route.questId } : {}),
    threadKey: destinationRoute.threadKey,
    ...(destinationRoute.questId ? { questId: destinationRoute.questId } : {}),
    transitionedAt: timestamp,
    reason: "route_switch",
    sourceMessageIndex: source.index,
  };
  history.push(marker);
  return marker;
}

export function compactIndexRanges(indices: number[]): string[] {
  if (indices.length === 0) return [];
  const ranges: string[] = [];
  let start = indices[0]!;
  let previous = start;
  for (const index of indices.slice(1)) {
    if (index === previous + 1) {
      previous = index;
      continue;
    }
    ranges.push(formatRange(start, previous));
    start = index;
    previous = index;
  }
  ranges.push(formatRange(start, previous));
  return ranges;
}

function findPreviousTransitionSourceRoute(
  history: BrowserIncomingMessage[],
): { route: ThreadRouteMetadata; index: number } | null {
  let crossedMainAssistantBoundary = false;

  for (let index = history.length - 1; index >= 0; index--) {
    const entry = history[index];
    if (!entry || entry.type === "thread_transition_marker") continue;
    const route = routeFromHistoryEntry(entry);
    if (route) {
      if (routeKey(route) === "main") return { route: { threadKey: "main" }, index };
      if (crossedMainAssistantBoundary) return null;
      if (!isQuestThreadKey(route.threadKey)) return null;
      return { route, index };
    }
    if (isImplicitMainHandoffSource(entry)) return { route: { threadKey: "main" }, index };
    if (isImplicitMainAssistantBoundary(entry)) {
      crossedMainAssistantBoundary = true;
      continue;
    }
    if (isCompletedTurnBoundary(entry)) return null;
  }
  return null;
}

function isImplicitMainHandoffSource(entry: BrowserIncomingMessage): boolean {
  switch (entry.type) {
    case "user_message":
    case "leader_user_message":
      return true;
    default:
      return false;
  }
}

function isImplicitMainAssistantBoundary(entry: BrowserIncomingMessage): boolean {
  switch (entry.type) {
    case "assistant":
      return true;
    default:
      return false;
  }
}

function isCompletedTurnBoundary(entry: BrowserIncomingMessage): boolean {
  return entry.type === "result";
}

function hasThreadTransitionMarker(history: BrowserIncomingMessage[], markerKey: string): boolean {
  return history.some((entry) => entry.type === "thread_transition_marker" && entry.markerKey === markerKey);
}

function formatRange(start: number, end: number): string {
  return start === end ? String(start) : `${start}-${end}`;
}
