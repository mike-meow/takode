import { normalizeThreadTarget } from "../../shared/thread-routing.js";
import type { ChatMessage, SessionAttentionRecord, SessionNotification } from "../types.js";
import { ALL_THREADS_KEY, MAIN_THREAD_KEY, normalizeThreadKey } from "./thread-projection.js";

export type AttentionRecord = SessionAttentionRecord;

export interface AttentionBoardRowSource {
  questId: string;
  title?: string;
  status?: string;
  waitFor?: string[];
  waitForInput?: string[];
  createdAt?: number;
  updatedAt: number;
  completedAt?: number;
}

export interface BuildAttentionRecordsInput {
  leaderSessionId: string;
  records?: ReadonlyArray<AttentionRecord>;
  notifications?: ReadonlyArray<SessionNotification>;
  boardRows?: ReadonlyArray<AttentionBoardRowSource>;
  completedBoardRows?: ReadonlyArray<AttentionBoardRowSource>;
  messages?: ReadonlyArray<ChatMessage>;
}

export interface BuildAttentionLedgerMessagesOptions {
  availableMessageIds?: ReadonlySet<string>;
}

interface ReviewNotificationDisplay {
  title: string;
  summary: string;
  kind?: "journey_finished";
  questId?: string;
  questIds: string[];
}

const ACTIVE_ATTENTION_STATES = new Set<AttentionRecord["state"]>(["unresolved", "seen", "reopened"]);
const JOURNEY_FINISHED_TITLE = "Journey finished";
const PRIORITY_ORDER = new Map<AttentionRecord["priority"], number>([
  ["needs_input", 0],
  ["review", 1],
  ["blocked", 2],
  ["created", 3],
  ["milestone", 4],
  ["completed", 5],
]);

export function buildAttentionRecords(input: BuildAttentionRecordsInput): AttentionRecord[] {
  const records = new Map<string, AttentionRecord>();
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

  for (const message of input.messages ?? []) {
    const record = attentionRecordFromReworkMessage(input.leaderSessionId, message);
    if (record) upsertAttentionRecord(records, record);
  }

  // Completed board rows are intentionally conservative for now. Without a
  // separate review-unread source they should not create active attention.
  void input.completedBoardRows;

  return applyJourneyLifecyclePresentation([...records.values()].sort(compareAttentionRecordsChronologically));
}

export function selectMainLedgerRecords(records: ReadonlyArray<AttentionRecord>): AttentionRecord[] {
  return records
    .filter(
      (record) =>
        record.ledgerEligible &&
        record.type !== "quest_thread_created" &&
        !isRedundantActiveNeedsInputNotification(record),
    )
    .sort(compareAttentionRecordsChronologically);
}

export function selectAttentionChipRecords(records: ReadonlyArray<AttentionRecord>): AttentionRecord[] {
  return records
    .filter((record) => record.chipEligible && isAttentionRecordActive(record))
    .sort(compareAttentionRecordsByPriority);
}

export function isAttentionRecordActive(record: Pick<AttentionRecord, "state">): boolean {
  return ACTIVE_ATTENTION_STATES.has(record.state);
}

function isRedundantActiveNeedsInputNotification(record: AttentionRecord): boolean {
  return (
    record.source.kind === "notification" &&
    record.priority === "needs_input" &&
    record.type === "needs_input" &&
    isAttentionRecordActive(record)
  );
}

export function isAttentionLedgerMessage(message: ChatMessage): boolean {
  return !!message.metadata?.attentionRecord;
}

export function buildAttentionLedgerMessages(
  records: ReadonlyArray<AttentionRecord>,
  threadKey: string = MAIN_THREAD_KEY,
  options: BuildAttentionLedgerMessagesOptions = {},
): ChatMessage[] {
  return selectLedgerRecordsForThread(records, threadKey, options.availableMessageIds).map(attentionRecordToMessage);
}

function selectLedgerRecordsForThread(
  records: ReadonlyArray<AttentionRecord>,
  threadKey: string,
  availableMessageIds?: ReadonlySet<string>,
): AttentionRecord[] {
  const normalized = normalizeThreadKey(threadKey);
  if (normalized === MAIN_THREAD_KEY) return selectMainLedgerRecords(records);
  if (normalized === ALL_THREADS_KEY) return [];

  return records
    .filter((record) => shouldRenderOwnerThreadNotificationRecord(record, normalized, availableMessageIds))
    .sort(compareAttentionRecordsChronologically);
}

function shouldRenderOwnerThreadNotificationRecord(
  record: AttentionRecord,
  threadKey: string,
  availableMessageIds?: ReadonlySet<string>,
): boolean {
  if (!record.ledgerEligible) return false;
  if (record.source.kind !== "notification") return false;
  if (record.type !== "needs_input" || record.priority !== "needs_input") return false;
  if (!isAttentionRecordActive(record)) return false;

  const targetThreadKey = normalizeThreadKey(record.route.threadKey || record.threadKey);
  if (targetThreadKey !== threadKey) return false;

  const anchoredMessageId = record.route.messageId || record.source.messageId || null;
  return !anchoredMessageId || !availableMessageIds?.has(anchoredMessageId);
}

export function mergeChronologicalMessages(messages: ChatMessage[], insertedMessages: ChatMessage[]): ChatMessage[] {
  if (insertedMessages.length === 0) return messages;
  if (messages.length === 0) return insertedMessages;
  return [...messages, ...insertedMessages].sort((a, b) => {
    const timeDelta = a.timestamp - b.timestamp;
    if (timeDelta !== 0) return timeDelta;
    return a.id.localeCompare(b.id);
  });
}

function attentionRecordsFromNotification(
  leaderSessionId: string,
  notification: SessionNotification,
  explicitFinishedQuestIds: ReadonlySet<string>,
): AttentionRecord[] {
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
      title: JOURNEY_FINISHED_TITLE,
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
): AttentionRecord {
  const isReview = notification.category === "review";
  const display: ReviewNotificationDisplay = isReview
    ? reviewDisplayFromNotification(notification)
    : {
        title: notification.summary ?? "Needs input",
        summary: notification.summary ?? "Needs input",
        questIds: [],
      };
  const route = routeForNotification(notification, display.questId);
  const state: AttentionRecord["state"] = notification.done ? "resolved" : "unresolved";
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

function reviewDisplayFromNotification(notification: SessionNotification): ReviewNotificationDisplay {
  const summary = notification.summary?.trim();
  if (!summary) return { title: JOURNEY_FINISHED_TITLE, summary: "", questIds: [] };

  const single = summary.match(/^\s*(q-\d+)\s+(?:ready\s+for\s+review|finished)(?:\s*:\s*(.+?))?\s*$/i);
  if (single) {
    const questId = single[1].trim();
    const title = single[2]?.trim();
    return {
      title: JOURNEY_FINISHED_TITLE,
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

function attentionRecordFromBoardRow(
  leaderSessionId: string,
  row: AttentionBoardRowSource,
  notifications: ReadonlyArray<SessionNotification>,
): AttentionRecord | null {
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

function attentionRecordFromReworkMessage(leaderSessionId: string, message: ChatMessage): AttentionRecord | null {
  if (message.role !== "user") return null;
  if (!message.content.trim()) return null;

  const route = questRouteFromMessage(message);
  if (!route?.questId) return null;
  if (!isReworkFeedbackText(message.content)) return null;

  const createdAt = message.timestamp;
  return {
    id: `message-rework:${message.id}`,
    leaderSessionId,
    type: "quest_reopened_or_rework",
    source: {
      kind: "message",
      id: message.id,
      questId: route.questId,
      messageId: message.id,
    },
    questId: route.questId,
    threadKey: route.threadKey,
    title: `${route.questId}: rework requested`,
    summary: summarizeReworkMessage(message.content),
    actionLabel: "Open",
    priority: "milestone",
    state: "reopened",
    createdAt,
    updatedAt: createdAt,
    reopenedAt: createdAt,
    route: {
      threadKey: route.threadKey,
      questId: route.questId,
      messageId: message.id,
    },
    chipEligible: false,
    ledgerEligible: true,
    dedupeKey: `message-rework:${message.id}`,
  };
}

function normalizeAttentionRecord(record: AttentionRecord, leaderSessionId: string): AttentionRecord {
  const route = normalizeRoute(record.route, record.threadKey, record.questId);
  return {
    ...record,
    leaderSessionId: record.leaderSessionId || leaderSessionId,
    threadKey: route.threadKey,
    ...(route.questId ? { questId: route.questId } : {}),
    ...(record.type === "quest_completed_recent" ? { title: JOURNEY_FINISHED_TITLE } : {}),
    route,
    dedupeKey: record.dedupeKey || record.id,
  };
}

function applyJourneyLifecyclePresentation(records: AttentionRecord[]): AttentionRecord[] {
  const startsByQuest = new Map<string, AttentionRecord[]>();
  const finishTimesByQuest = new Map<string, number[]>();

  for (const record of records) {
    if (!record.questId) continue;
    const questId = record.questId.toLowerCase();
    if (record.type === "quest_journey_started") {
      const starts = startsByQuest.get(questId) ?? [];
      starts.push(record);
      startsByQuest.set(questId, starts);
    }
    if (record.type === "quest_completed_recent") {
      const finishes = finishTimesByQuest.get(questId) ?? [];
      finishes.push(record.createdAt);
      finishTimesByQuest.set(questId, finishes);
    }
  }

  for (const starts of startsByQuest.values()) {
    starts.sort(compareAttentionRecordsChronologically);
  }
  for (const finishes of finishTimesByQuest.values()) {
    finishes.sort((a, b) => a - b);
  }

  return records.map((record) => {
    if (record.type === "quest_completed_recent") {
      return { ...record, title: JOURNEY_FINISHED_TITLE, journeyLifecycleStatus: "completed" };
    }
    if (record.type !== "quest_journey_started" || !record.questId) return record;

    const questId = record.questId.toLowerCase();
    const starts = startsByQuest.get(questId) ?? [];
    const startIndex = starts.findIndex((start) => start.id === record.id);
    const nextStartAt = startIndex >= 0 ? starts[startIndex + 1]?.createdAt : undefined;
    const finishTimes = finishTimesByQuest.get(questId) ?? [];
    const hasMatchingFinish = finishTimes.some(
      (finishedAt) => finishedAt >= record.createdAt && (nextStartAt === undefined || finishedAt < nextStartAt),
    );

    return {
      ...record,
      journeyLifecycleStatus: hasMatchingFinish ? "completed" : "active",
    };
  });
}

function routeForNotification(notification: SessionNotification, inferredQuestId?: string): AttentionRecord["route"] {
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
  route: AttentionRecord["route"],
  fallbackThreadKey: string | undefined,
  fallbackQuestId: string | undefined,
): AttentionRecord["route"] {
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

function questRouteFromMessage(message: ChatMessage): { threadKey: string; questId: string } | null {
  const candidates = [
    message.metadata?.threadKey,
    message.metadata?.questId,
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

function attentionRecordToMessage(record: AttentionRecord): ChatMessage {
  return {
    id: attentionLedgerMessageIdForRecord(record),
    role: "system",
    content: `${record.actionLabel}: ${record.title}`,
    timestamp: record.createdAt,
    variant: "info",
    ephemeral: true,
    metadata: {
      threadKey: MAIN_THREAD_KEY,
      attentionRecord: record,
    },
  };
}

export function attentionLedgerMessageIdForRecord(record: Pick<AttentionRecord, "id">): string {
  return `attention-ledger:${record.id}`;
}

export function attentionLedgerMessageIdForNotificationId(notificationId: string): string {
  return `attention-ledger:notification:${notificationId}`;
}

function upsertAttentionRecord(records: Map<string, AttentionRecord>, record: AttentionRecord): void {
  const existing = records.get(record.dedupeKey);
  if (!existing) {
    records.set(record.dedupeKey, record);
    return;
  }

  records.set(record.dedupeKey, mergeAttentionRecords(existing, record));
}

function mergeAttentionRecords(existing: AttentionRecord, incoming: AttentionRecord): AttentionRecord {
  const latest = incoming.updatedAt >= existing.updatedAt ? incoming : existing;
  const earlier = latest === incoming ? existing : incoming;
  return {
    ...earlier,
    ...latest,
    createdAt: Math.min(existing.createdAt, incoming.createdAt),
    updatedAt: Math.max(existing.updatedAt, incoming.updatedAt),
  };
}

function compareAttentionRecordsChronologically(a: AttentionRecord, b: AttentionRecord): number {
  const timeDelta = a.createdAt - b.createdAt;
  if (timeDelta !== 0) return timeDelta;
  return a.id.localeCompare(b.id);
}

function compareAttentionRecordsByPriority(a: AttentionRecord, b: AttentionRecord): number {
  const priorityDelta = (PRIORITY_ORDER.get(a.priority) ?? 99) - (PRIORITY_ORDER.get(b.priority) ?? 99);
  if (priorityDelta !== 0) return priorityDelta;
  const recencyDelta = b.updatedAt - a.updatedAt;
  if (recencyDelta !== 0) return recencyDelta;
  return a.id.localeCompare(b.id);
}
