import type {
  BoardRow,
  BoardRowSessionStatus,
  BrowserIncomingMessage,
  ContentBlock,
  LeaderProjectionSnapshot,
  LeaderProjectionThreadRow,
  LeaderProjectionThreadSummary,
  SessionAttentionRecord,
  SessionNotification,
  ThreadAttachmentMarker,
  ThreadRef,
  ThreadTransitionMarker,
} from "../server/session-types.js";
import type { QuestmasterTask } from "../server/quest-types.js";
import { normalizeThreadTarget, parseCommandThreadComment, parseThreadTextPrefix } from "./thread-routing.js";

export interface LeaderProjectionBoardRow extends Omit<BoardRow, "createdAt"> {
  createdAt?: number;
}

export interface LeaderProjectionMessageLike {
  id?: string;
  type?: string;
  role?: string;
  content?: unknown;
  contentBlocks?: ContentBlock[];
  message?: unknown;
  timestamp?: number;
  parentToolUseId?: string | null;
  threadKey?: string;
  questId?: string;
  threadRefs?: ThreadRef[];
  metadata?: {
    threadKey?: string;
    questId?: string;
    threadRefs?: ThreadRef[];
    threadAttachmentMarker?: ThreadAttachmentMarker;
    threadTransitionMarker?: ThreadTransitionMarker;
    quest?: { questId?: string };
  };
  historyIndex?: number;
}

export interface BuildLeaderProjectionInput {
  leaderSessionId: string;
  messageHistory: ReadonlyArray<LeaderProjectionMessageLike>;
  activeBoard?: ReadonlyArray<LeaderProjectionBoardRow>;
  completedBoard?: ReadonlyArray<LeaderProjectionBoardRow>;
  quests?: ReadonlyArray<Pick<QuestmasterTask, "questId" | "title" | "status" | "createdAt">>;
  rowSessionStatuses?: Record<string, BoardRowSessionStatus>;
  notifications?: ReadonlyArray<SessionNotification>;
  attentionRecords?: ReadonlyArray<SessionAttentionRecord>;
  revision?: number;
  generatedAt?: number;
}

export interface BuildLeaderThreadRowsInput {
  activeBoard?: ReadonlyArray<LeaderProjectionBoardRow>;
  completedBoard?: ReadonlyArray<LeaderProjectionBoardRow>;
  threadSummaries?: ReadonlyArray<LeaderProjectionThreadSummary>;
  quests?: ReadonlyArray<Pick<QuestmasterTask, "questId" | "title" | "status" | "createdAt">>;
  rowSessionStatuses?: Record<string, BoardRowSessionStatus>;
}

export const MAIN_THREAD_KEY = "main";
export const ALL_THREADS_KEY = "all";

export function buildLeaderProjectionSnapshot(input: BuildLeaderProjectionInput): LeaderProjectionSnapshot {
  const threadSummaries = collectLeaderThreadSummaries(input.messageHistory);
  const messageAttentionRecords = collectMessageAttentionRecords(input.leaderSessionId, input.messageHistory);
  const activeBoard = [...(input.activeBoard ?? [])];
  const completedBoard = [...(input.completedBoard ?? [])];
  const attentionRecords = buildProjectionAttentionRecords({
    leaderSessionId: input.leaderSessionId,
    records: [...(input.attentionRecords ?? []), ...messageAttentionRecords],
    notifications: input.notifications,
    boardRows: activeBoard,
    completedBoardRows: completedBoard,
  });
  const threadRows = buildLeaderThreadRowsFromSummaries({
    activeBoard,
    completedBoard,
    threadSummaries,
    quests: input.quests,
    rowSessionStatuses: input.rowSessionStatuses,
  });
  return {
    schemaVersion: 1,
    revision: input.revision ?? buildProjectionRevision(input),
    sourceHistoryLength: input.messageHistory.length,
    generatedAt: input.generatedAt ?? Date.now(),
    threadSummaries,
    threadRows,
    workBoardThreadRows: threadRows.map(toWorkBoardThreadRow),
    messageAttentionRecords,
    attentionRecords,
    rawTurnBoundaries: buildRawTurnBoundaries(input.messageHistory),
  };
}

export function collectLeaderThreadSummaries(
  messages: ReadonlyArray<LeaderProjectionMessageLike>,
): LeaderProjectionThreadSummary[] {
  const summaries = new Map<string, LeaderProjectionThreadSummary>();
  messages.forEach((message, index) => {
    for (const key of messageThreadKeys(message)) {
      const timestamp = timestampForMessage(message);
      const historyIndex = historyIndexForMessage(message, index);
      const existing = summaries.get(key);
      if (!existing) {
        summaries.set(key, {
          threadKey: key,
          ...(isQuestThreadKey(key) ? { questId: key } : {}),
          messageCount: 1,
          firstMessageAt: timestamp,
          lastMessageAt: timestamp,
          firstHistoryIndex: historyIndex,
          lastHistoryIndex: historyIndex,
        });
        continue;
      }
      existing.messageCount += 1;
      existing.firstMessageAt = minDefined(existing.firstMessageAt, timestamp);
      existing.lastMessageAt = maxDefined(existing.lastMessageAt, timestamp);
      existing.firstHistoryIndex = minDefined(existing.firstHistoryIndex, historyIndex);
      existing.lastHistoryIndex = maxDefined(existing.lastHistoryIndex, historyIndex);
      if (!existing.questId && isQuestThreadKey(key)) existing.questId = key;
    }
  });
  return [...summaries.values()].sort(compareThreadSummaries);
}

export function mergeLeaderThreadSummaries(
  base: ReadonlyArray<LeaderProjectionThreadSummary>,
  updates: ReadonlyArray<LeaderProjectionThreadSummary>,
): LeaderProjectionThreadSummary[] {
  const merged = new Map<string, LeaderProjectionThreadSummary>();
  for (const summary of [...base, ...updates]) {
    const key = normalizeThreadKey(summary.threadKey);
    if (!key || key === MAIN_THREAD_KEY) continue;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...summary, threadKey: key });
      continue;
    }
    merged.set(key, {
      threadKey: key,
      questId: existing.questId ?? summary.questId,
      messageCount: existing.messageCount + summary.messageCount,
      firstMessageAt: minDefined(existing.firstMessageAt, summary.firstMessageAt),
      lastMessageAt: maxDefined(existing.lastMessageAt, summary.lastMessageAt),
      firstHistoryIndex: minDefined(existing.firstHistoryIndex, summary.firstHistoryIndex),
      lastHistoryIndex: maxDefined(existing.lastHistoryIndex, summary.lastHistoryIndex),
    });
  }
  return [...merged.values()].sort(compareThreadSummaries);
}

export function buildLeaderThreadRowsFromSummaries(input: BuildLeaderThreadRowsInput): LeaderProjectionThreadRow[] {
  const questById = new Map((input.quests ?? []).map((quest) => [quest.questId.toLowerCase(), quest]));
  const rows = new Map<string, LeaderProjectionThreadRow>();
  const counts = new Map<string, number>();
  const firstMessageAt = new Map<string, number>();

  for (const summary of input.threadSummaries ?? []) {
    const key = normalizeThreadKey(summary.threadKey);
    if (!key || key === MAIN_THREAD_KEY) continue;
    counts.set(key, (counts.get(key) ?? 0) + summary.messageCount);
    if (typeof summary.firstMessageAt === "number") {
      firstMessageAt.set(key, Math.min(firstMessageAt.get(key) ?? Number.POSITIVE_INFINITY, summary.firstMessageAt));
    }
  }

  const activeBoard = input.activeBoard ?? [];
  const completedBoard = input.completedBoard ?? [];
  const activeKeys = new Set(activeBoard.map((row) => row.questId.toLowerCase()));
  const boardRowById = new Map<string, LeaderProjectionBoardRow>();
  for (const row of [...activeBoard, ...completedBoard]) {
    boardRowById.set(row.questId.toLowerCase(), row);
  }

  const creationTimeFor = (questId: string, row?: LeaderProjectionBoardRow) => {
    const key = questId.toLowerCase();
    return (
      questById.get(key)?.createdAt ??
      row?.createdAt ??
      firstMessageAt.get(key) ??
      row?.updatedAt ??
      Number.MAX_SAFE_INTEGER
    );
  };

  const addQuestRow = (questId: string, partial: Partial<LeaderProjectionThreadRow> = {}) => {
    const key = questId.toLowerCase();
    const quest = questById.get(key);
    const existing = rows.get(key);
    const boardRow = partial.boardRow ?? existing?.boardRow ?? boardRowById.get(key);
    const messageCount = counts.get(key) ?? existing?.messageCount ?? 0;
    if (messageCount <= 0 && !boardRow) return;
    const section = activeKeys.has(key) ? "active" : "done";
    rows.set(key, {
      threadKey: key,
      questId: key,
      title: partial.title ?? existing?.title ?? quest?.title ?? questId,
      status: partial.status ?? existing?.status ?? quest?.status,
      boardStatus: partial.boardStatus ?? existing?.boardStatus,
      journey: partial.journey ?? existing?.journey,
      boardRow: boardRow as BoardRow | undefined,
      rowStatus: partial.rowStatus ?? existing?.rowStatus ?? input.rowSessionStatuses?.[key],
      messageCount,
      createdAt: Math.min(
        partial.createdAt ?? Number.MAX_SAFE_INTEGER,
        existing?.createdAt ?? creationTimeFor(key, boardRow),
      ),
      section,
    });
  };

  for (const row of activeBoard) {
    const key = row.questId.toLowerCase();
    addQuestRow(row.questId, {
      title: row.title,
      boardStatus: row.status,
      journey: row.journey,
      boardRow: row as BoardRow,
      rowStatus: input.rowSessionStatuses?.[key],
      createdAt: creationTimeFor(key, row),
    });
  }
  for (const row of completedBoard) {
    const key = row.questId.toLowerCase();
    addQuestRow(row.questId, {
      title: row.title,
      boardStatus: row.status,
      journey: row.journey,
      boardRow: row as BoardRow,
      rowStatus: input.rowSessionStatuses?.[key],
      createdAt: creationTimeFor(key, row),
    });
  }
  for (const key of counts.keys()) {
    if (isQuestThreadKey(key)) {
      addQuestRow(key, { createdAt: creationTimeFor(key, boardRowById.get(key)) });
    }
  }

  return [...rows.values()].sort((a, b) => a.createdAt - b.createdAt || a.threadKey.localeCompare(b.threadKey));
}

export function collectMessageAttentionRecords(
  leaderSessionId: string,
  messages: ReadonlyArray<LeaderProjectionMessageLike>,
): SessionAttentionRecord[] {
  const records: SessionAttentionRecord[] = [];
  messages.forEach((message, index) => {
    const record = attentionRecordFromReworkMessage(leaderSessionId, message, index);
    if (record) records.push(record);
  });
  return records.sort(compareAttentionRecordsChronologically);
}

export function buildProjectionAttentionRecords(input: {
  leaderSessionId: string;
  records?: ReadonlyArray<SessionAttentionRecord>;
  notifications?: ReadonlyArray<SessionNotification>;
  boardRows?: ReadonlyArray<LeaderProjectionBoardRow>;
  completedBoardRows?: ReadonlyArray<LeaderProjectionBoardRow>;
}): SessionAttentionRecord[] {
  const records = new Map<string, SessionAttentionRecord>();
  const notifications = input.notifications ?? [];
  const explicitFinishedQuestIds = new Set<string>();

  for (const record of input.records ?? []) {
    const normalized = normalizeAttentionRecord(record, input.leaderSessionId);
    if (normalized.type === "quest_completed_recent" && normalized.questId) {
      explicitFinishedQuestIds.add(normalized.questId.toLowerCase());
    }
    upsertAttentionRecord(records, normalized);
  }
  for (const notification of notifications) {
    for (const record of attentionRecordsFromNotification(
      input.leaderSessionId,
      notification,
      explicitFinishedQuestIds,
    )) {
      upsertAttentionRecord(records, record);
    }
  }
  for (const row of input.boardRows ?? []) {
    const record = attentionRecordFromBoardRow(input.leaderSessionId, row, notifications);
    if (record) upsertAttentionRecord(records, record);
  }

  void input.completedBoardRows;
  return [...records.values()].sort(compareAttentionRecordsChronologically);
}

export function normalizeThreadKey(threadKey: string): string {
  return threadKey.trim().toLowerCase();
}

function buildProjectionRevision(input: BuildLeaderProjectionInput): number {
  const notificationVersion = input.notifications?.length ?? 0;
  const attentionVersion = input.attentionRecords?.length ?? 0;
  const boardVersion = (input.activeBoard?.length ?? 0) + (input.completedBoard?.length ?? 0);
  return input.messageHistory.length * 1_000_000 + notificationVersion * 10_000 + attentionVersion * 100 + boardVersion;
}

function toWorkBoardThreadRow(row: LeaderProjectionThreadRow): LeaderProjectionSnapshot["workBoardThreadRows"][number] {
  return {
    threadKey: row.threadKey,
    questId: row.questId,
    title: row.title,
    messageCount: row.messageCount,
    section: row.section,
  };
}

function buildRawTurnBoundaries(
  messages: ReadonlyArray<LeaderProjectionMessageLike>,
): LeaderProjectionSnapshot["rawTurnBoundaries"] {
  const boundaries: LeaderProjectionSnapshot["rawTurnBoundaries"] = [];
  let currentStart: number | null = null;
  messages.forEach((message, index) => {
    if (message.type === "user_message" || message.role === "user") {
      if (currentStart !== null) {
        boundaries.push({ turnIndex: boundaries.length, startHistoryIndex: currentStart, endHistoryIndex: index - 1 });
      }
      currentStart = historyIndexForMessage(message, index);
      return;
    }
    if (message.type !== "result") return;
    if (currentStart === null) return;
    boundaries.push({
      turnIndex: boundaries.length,
      startHistoryIndex: currentStart,
      endHistoryIndex: historyIndexForMessage(message, index),
    });
    currentStart = null;
  });
  if (currentStart !== null) {
    boundaries.push({ turnIndex: boundaries.length, startHistoryIndex: currentStart, endHistoryIndex: null });
  }
  return boundaries;
}

function messageThreadKeys(message: LeaderProjectionMessageLike): string[] {
  const keys = new Set<string>();
  const addThreadKey = (threadKey: string | undefined) => {
    if (!threadKey) return;
    const normalized = normalizeThreadKey(threadKey);
    if (!normalized || normalized === MAIN_THREAD_KEY) return;
    keys.add(normalized);
  };

  const metadata = message.metadata;
  addThreadKey(message.threadKey);
  addThreadKey(message.questId);
  addThreadKey(metadata?.threadKey);
  addThreadKey(metadata?.questId);
  addThreadKey(metadata?.quest?.questId);
  for (const ref of [...(message.threadRefs ?? []), ...(metadata?.threadRefs ?? [])]) {
    addThreadKey(ref.threadKey);
    addThreadKey(ref.questId);
  }

  const attachment = getThreadAttachmentMarker(message);
  addThreadKey(attachment?.threadKey);
  addThreadKey(attachment?.questId);
  addThreadKey(attachment?.sourceThreadKey);
  addThreadKey(attachment?.sourceQuestId);

  const transition = getThreadTransitionMarker(message);
  addThreadKey(transition?.threadKey);
  addThreadKey(transition?.questId);
  addThreadKey(transition?.sourceThreadKey);
  addThreadKey(transition?.sourceQuestId);

  for (const text of messageTextParts(message)) {
    const parsedPrefix = parseThreadTextPrefix(text);
    if (parsedPrefix.ok) addThreadKey(parsedPrefix.target.threadKey);
  }
  for (const block of messageContentBlocks(message)) {
    if (block.type !== "tool_use" || block.name !== "Bash" || typeof block.input?.command !== "string") continue;
    addThreadKey(parseCommandThreadComment(block.input.command)?.threadKey);
  }
  return [...keys];
}

function getThreadAttachmentMarker(message: LeaderProjectionMessageLike): ThreadAttachmentMarker | undefined {
  if (message.metadata?.threadAttachmentMarker) return message.metadata.threadAttachmentMarker;
  return message.type === "thread_attachment_marker" ? (message as ThreadAttachmentMarker) : undefined;
}

function getThreadTransitionMarker(message: LeaderProjectionMessageLike): ThreadTransitionMarker | undefined {
  if (message.metadata?.threadTransitionMarker) return message.metadata.threadTransitionMarker;
  return message.type === "thread_transition_marker" ? (message as ThreadTransitionMarker) : undefined;
}

function messageTextParts(message: LeaderProjectionMessageLike): string[] {
  const texts: string[] = [];
  if (typeof message.content === "string") texts.push(message.content);
  for (const block of messageContentBlocks(message)) {
    if (block.type === "text") texts.push(block.text);
  }
  return texts;
}

function messageContentBlocks(message: LeaderProjectionMessageLike): ContentBlock[] {
  if (Array.isArray(message.contentBlocks)) return message.contentBlocks;
  const rawMessage = message.message as { content?: unknown } | null | undefined;
  if (Array.isArray(rawMessage?.content)) return rawMessage.content as ContentBlock[];
  return [];
}

function timestampForMessage(message: LeaderProjectionMessageLike): number {
  return typeof message.timestamp === "number" ? message.timestamp : 0;
}

function historyIndexForMessage(message: LeaderProjectionMessageLike, fallback: number): number {
  return typeof message.historyIndex === "number" ? message.historyIndex : fallback;
}

function messageIdForProjection(message: LeaderProjectionMessageLike, fallbackIndex: number): string {
  if (typeof message.id === "string" && message.id) return message.id;
  const raw = message as { message?: { id?: string }; data?: { uuid?: string }; cliUuid?: string };
  return raw.message?.id ?? raw.data?.uuid ?? raw.cliUuid ?? `history-${fallbackIndex}`;
}

function isUserAuthoredMessage(message: LeaderProjectionMessageLike): boolean {
  return message.role === "user" || message.type === "user_message" || message.type === "leader_user_message";
}

function attentionRecordFromReworkMessage(
  leaderSessionId: string,
  message: LeaderProjectionMessageLike,
  index: number,
): SessionAttentionRecord | null {
  if (!isUserAuthoredMessage(message)) return null;
  const content = typeof message.content === "string" ? message.content : "";
  if (!content.trim()) return null;
  const route = questRouteFromMessage(message);
  if (!route?.questId) return null;
  if (!isReworkFeedbackText(content)) return null;

  const messageId = messageIdForProjection(message, index);
  const createdAt = timestampForMessage(message);
  return {
    id: `message-rework:${messageId}`,
    leaderSessionId,
    type: "quest_reopened_or_rework",
    source: {
      kind: "message",
      id: messageId,
      questId: route.questId,
      messageId,
    },
    questId: route.questId,
    threadKey: route.threadKey,
    title: `${route.questId}: rework requested`,
    summary: summarizeReworkMessage(content),
    actionLabel: "Open",
    priority: "milestone",
    state: "reopened",
    createdAt,
    updatedAt: createdAt,
    reopenedAt: createdAt,
    route: {
      threadKey: route.threadKey,
      questId: route.questId,
      messageId,
    },
    chipEligible: false,
    ledgerEligible: true,
    dedupeKey: `message-rework:${messageId}`,
  };
}

function attentionRecordFromBoardRow(
  leaderSessionId: string,
  row: LeaderProjectionBoardRow,
  notifications: ReadonlyArray<SessionNotification>,
): SessionAttentionRecord | null {
  const waitForInput = row.waitForInput ?? [];
  if (waitForInput.length === 0) return null;

  const notificationIds = new Set(notifications.map((notification) => notification.id));
  if (waitForInput.every((id) => notificationIds.has(id))) return null;

  const signature = waitForInput.slice().sort().join(",");
  const createdAt = row.createdAt ?? row.updatedAt;
  const title = row.title ? `${row.questId}: ${row.title}` : row.questId;
  return {
    id: `board-needs-input:${row.questId}:${signature}`,
    leaderSessionId,
    type: "needs_input",
    source: {
      kind: "board",
      id: row.questId,
      questId: row.questId,
      signature,
    },
    questId: row.questId,
    threadKey: row.questId.toLowerCase(),
    title,
    summary: `Waiting for input: ${waitForInput.join(", ")}`,
    actionLabel: "Answer",
    priority: "needs_input",
    state: "unresolved",
    createdAt,
    updatedAt: row.updatedAt,
    route: {
      threadKey: row.questId.toLowerCase(),
      questId: row.questId,
      bannerId: "needs-input",
    },
    chipEligible: true,
    ledgerEligible: true,
    dedupeKey: `board-needs-input:${row.questId}:${signature}`,
  };
}

function attentionRecordsFromNotification(
  leaderSessionId: string,
  notification: SessionNotification,
  explicitFinishedQuestIds: ReadonlySet<string>,
): SessionAttentionRecord[] {
  const baseRecord = attentionRecordFromNotification(leaderSessionId, notification, explicitFinishedQuestIds);
  if (baseRecord.type !== "quest_completed_recent") return [baseRecord];

  const questIds = parseQuestIdsFromReviewSummary(notification.summary);
  if (questIds.length <= 1) return [baseRecord];

  const missingQuestIds = questIds.filter((questId) => !explicitFinishedQuestIds.has(questId.toLowerCase()));
  if (missingQuestIds.length === 0) return [baseRecord];

  return missingQuestIds.map((questId) => {
    const threadKey = questId.toLowerCase();
    return {
      ...baseRecord,
      id: `notification:${notification.id}:${threadKey}`,
      source: {
        ...baseRecord.source,
        questId,
        signature: `${notification.id}:${threadKey}`,
      },
      questId,
      threadKey,
      title: "Finished",
      summary: `${questIds.length} quests finished`,
      actionLabel: "Open",
      chipEligible: false,
      ledgerEligible: true,
      route: {
        ...baseRecord.route,
        threadKey,
        questId,
      },
      dedupeKey: `notification:${notification.id}:${threadKey}`,
    };
  });
}

function attentionRecordFromNotification(
  leaderSessionId: string,
  notification: SessionNotification,
  explicitFinishedQuestIds: ReadonlySet<string>,
): SessionAttentionRecord {
  const isReview = notification.category === "review";
  const display = isReview
    ? reviewDisplayFromNotification(notification)
    : {
        title: notification.summary ?? "Needs input",
        summary: notification.summary ?? "Needs input",
        questIds: [] as string[],
      };
  const route = routeForNotification(notification, display.questId);
  const state: SessionAttentionRecord["state"] = notification.done ? "resolved" : "unresolved";
  const isJourneyFinished = display.kind === "journey_finished";
  const hasExplicitFinishedRecords =
    isJourneyFinished &&
    display.questIds.length > 0 &&
    display.questIds.every((questId) => explicitFinishedQuestIds.has(questId.toLowerCase()));

  return {
    id: `notification:${notification.id}`,
    leaderSessionId,
    type: isJourneyFinished ? "quest_completed_recent" : isReview ? "review_ready" : "needs_input",
    source: {
      kind: "notification",
      id: notification.id,
      ...(route.questId ? { questId: route.questId } : notification.questId ? { questId: notification.questId } : {}),
      messageId: notification.messageId,
    },
    ...(route.questId ? { questId: route.questId } : {}),
    threadKey: route.threadKey,
    title: display.title,
    summary: display.summary,
    actionLabel: isJourneyFinished ? "Open" : isReview ? "Review" : "Answer",
    priority: isReview ? "review" : "needs_input",
    state,
    createdAt: notification.timestamp,
    updatedAt: notification.timestamp,
    ...(state === "resolved" ? { resolvedAt: notification.timestamp } : {}),
    route,
    chipEligible: !isJourneyFinished,
    ledgerEligible: !hasExplicitFinishedRecords,
    dedupeKey: `notification:${notification.id}`,
  };
}

function reviewDisplayFromNotification(notification: SessionNotification): {
  title: string;
  summary: string;
  kind?: "journey_finished";
  questId?: string;
  questIds: string[];
} {
  const summary = notification.summary?.trim();
  if (!summary) return { title: "Finished", summary: "", questIds: [] };

  const single = summary.match(/^\s*(q-\d+)\s+(?:ready\s+for\s+review|finished)(?:\s*:\s*(.+?))?\s*$/i);
  if (single) {
    const questId = single[1].trim();
    const title = single[2]?.trim();
    return {
      title: "Finished",
      summary: title ?? "",
      kind: "journey_finished",
      questId,
      questIds: [questId],
    };
  }

  const multi = summary.match(/^\s*(\d+)\s+quests?\s+(?:ready\s+for\s+review|finished)\s*:\s*(.+?)\s*$/i);
  if (multi) {
    const count = multi[1];
    const quests = multi[2].trim();
    const questIds = [...quests.matchAll(/\bq-\d+\b/gi)].map((match) => match[0].toLowerCase());
    return {
      title: `${count} ${count === "1" ? "quest" : "quests"} finished`,
      summary: quests,
      kind: "journey_finished",
      questIds,
    };
  }

  return {
    title: summary.replace(/\bready\s+for\s+review\b/gi, "finished"),
    summary: "",
    questIds: [],
  };
}

function parseQuestIdsFromReviewSummary(summary: string | undefined): string[] {
  const match = summary?.match(/^\s*\d+\s+quests?\s+(?:ready\s+for\s+review|finished)\s*:\s*(.+?)\s*$/i);
  if (!match) return [];
  return [...match[1].matchAll(/\bq-\d+\b/gi)].map((questIdMatch) => questIdMatch[0].toLowerCase());
}

function normalizeAttentionRecord(record: SessionAttentionRecord, leaderSessionId: string): SessionAttentionRecord {
  const route = normalizeRoute(record.route, record.threadKey, record.questId);
  return {
    ...record,
    leaderSessionId: record.leaderSessionId || leaderSessionId,
    threadKey: route.threadKey,
    ...(route.questId ? { questId: route.questId } : {}),
    route,
    dedupeKey: record.dedupeKey || record.id,
  };
}

function routeForNotification(
  notification: SessionNotification,
  inferredQuestId?: string,
): SessionAttentionRecord["route"] {
  const target = normalizeRouteTarget(
    notification.threadKey ?? notification.questId ?? inferredQuestId ?? MAIN_THREAD_KEY,
  );
  return {
    threadKey: target.threadKey,
    ...(target.questId ? { questId: target.questId } : {}),
    ...(notification.messageId ? { messageId: notification.messageId } : {}),
  };
}

function normalizeRoute(
  route: SessionAttentionRecord["route"],
  fallbackThreadKey: string | undefined,
  fallbackQuestId: string | undefined,
): SessionAttentionRecord["route"] {
  const target = normalizeRouteTarget(route.threadKey || fallbackThreadKey || fallbackQuestId || MAIN_THREAD_KEY);
  return {
    ...route,
    threadKey: target.threadKey,
    ...(target.questId ? { questId: target.questId } : {}),
  };
}

function normalizeRouteTarget(raw: string): { threadKey: string; questId?: string } {
  const target = normalizeThreadTarget(raw);
  if (target) return target;
  return { threadKey: normalizeThreadKey(raw) || MAIN_THREAD_KEY };
}

function questRouteFromMessage(message: LeaderProjectionMessageLike): { threadKey: string; questId: string } | null {
  const candidates = [
    message.threadKey,
    message.questId,
    message.metadata?.threadKey,
    message.metadata?.questId,
    ...(message.threadRefs ?? []).flatMap((ref) => [ref.threadKey, ref.questId]),
    ...(message.metadata?.threadRefs ?? []).flatMap((ref) => [ref.threadKey, ref.questId]),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const target = normalizeThreadTarget(candidate);
    if (target?.questId && target.threadKey !== MAIN_THREAD_KEY) {
      return { threadKey: target.threadKey, questId: target.questId };
    }
  }
  return null;
}

function isReworkFeedbackText(content: string): boolean {
  const lower = content.toLowerCase().replace(/\s+/g, " ").trim();
  return (
    lower.includes("please ask the agent to fix") ||
    lower.includes("ask the agent to fix") ||
    lower.includes("needs rework") ||
    lower.includes("need rework") ||
    lower.includes("requires rework") ||
    lower.includes("rework requested") ||
    (lower.includes("looks horrible") && lower.includes("agent") && lower.includes("fix"))
  );
}

function summarizeReworkMessage(content: string): string {
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return "User requested rework in this quest thread.";
  return firstLine.length > 140 ? `${firstLine.slice(0, 137)}...` : firstLine;
}

function upsertAttentionRecord(records: Map<string, SessionAttentionRecord>, record: SessionAttentionRecord): void {
  const existing = records.get(record.dedupeKey);
  if (!existing) {
    records.set(record.dedupeKey, record);
    return;
  }
  records.set(record.dedupeKey, mergeAttentionRecords(existing, record));
}

function mergeAttentionRecords(
  existing: SessionAttentionRecord,
  incoming: SessionAttentionRecord,
): SessionAttentionRecord {
  const latest = incoming.updatedAt >= existing.updatedAt ? incoming : existing;
  const earlier = latest === incoming ? existing : incoming;
  return {
    ...earlier,
    ...latest,
    createdAt: Math.min(existing.createdAt, incoming.createdAt),
    updatedAt: Math.max(existing.updatedAt, incoming.updatedAt),
  };
}

function compareAttentionRecordsChronologically(a: SessionAttentionRecord, b: SessionAttentionRecord): number {
  const timeDelta = a.createdAt - b.createdAt;
  if (timeDelta !== 0) return timeDelta;
  return a.id.localeCompare(b.id);
}

function compareThreadSummaries(a: LeaderProjectionThreadSummary, b: LeaderProjectionThreadSummary): number {
  const timeDelta = (a.firstMessageAt ?? Number.MAX_SAFE_INTEGER) - (b.firstMessageAt ?? Number.MAX_SAFE_INTEGER);
  if (timeDelta !== 0) return timeDelta;
  return a.threadKey.localeCompare(b.threadKey);
}

function minDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

function isQuestThreadKey(threadKey: string): boolean {
  return /^q-\d+$/i.test(threadKey.trim());
}
