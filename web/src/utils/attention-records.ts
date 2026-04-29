import { normalizeThreadTarget } from "../../shared/thread-routing.js";
import type { ChatMessage, SessionAttentionRecord, SessionNotification } from "../types.js";
import { MAIN_THREAD_KEY, normalizeThreadKey } from "./thread-projection.js";

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

const ACTIVE_ATTENTION_STATES = new Set<AttentionRecord["state"]>(["unresolved", "seen", "reopened"]);
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

  for (const record of input.records ?? []) {
    upsertAttentionRecord(records, normalizeAttentionRecord(record, input.leaderSessionId));
  }

  for (const notification of notifications) {
    upsertAttentionRecord(records, attentionRecordFromNotification(input.leaderSessionId, notification));
  }

  for (const row of input.boardRows ?? []) {
    const record = attentionRecordFromBoardRow(input.leaderSessionId, row, notifications);
    if (record) upsertAttentionRecord(records, record);
  }

  // Completed board rows are intentionally conservative for now. Without a
  // separate review-unread source they should not create active attention.
  void input.completedBoardRows;
  void input.messages;

  return [...records.values()].sort(compareAttentionRecordsChronologically);
}

export function selectMainLedgerRecords(records: ReadonlyArray<AttentionRecord>): AttentionRecord[] {
  return records.filter((record) => record.ledgerEligible).sort(compareAttentionRecordsChronologically);
}

export function selectAttentionChipRecords(records: ReadonlyArray<AttentionRecord>): AttentionRecord[] {
  return records
    .filter((record) => record.chipEligible && isAttentionRecordActive(record))
    .sort(compareAttentionRecordsByPriority);
}

export function isAttentionRecordActive(record: Pick<AttentionRecord, "state">): boolean {
  return ACTIVE_ATTENTION_STATES.has(record.state);
}

export function isAttentionLedgerMessage(message: ChatMessage): boolean {
  return !!message.metadata?.attentionRecord;
}

export function buildAttentionLedgerMessages(records: ReadonlyArray<AttentionRecord>): ChatMessage[] {
  return selectMainLedgerRecords(records).map(attentionRecordToMessage);
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

function attentionRecordFromNotification(leaderSessionId: string, notification: SessionNotification): AttentionRecord {
  const isReview = notification.category === "review";
  const route = routeForNotification(notification);
  const state: AttentionRecord["state"] = notification.done ? "resolved" : "unresolved";
  const title = notification.summary ?? (isReview ? "Ready for review" : "Needs input");

  return {
    id: `notification:${notification.id}`,
    leaderSessionId,
    type: isReview ? "review_ready" : "needs_input",
    source: {
      kind: "notification",
      id: notification.id,
      ...(notification.questId ? { questId: notification.questId } : {}),
      messageId: notification.messageId,
    },
    ...(route.questId ? { questId: route.questId } : {}),
    threadKey: route.threadKey,
    title,
    summary: title,
    actionLabel: isReview ? "Review" : "Answer",
    priority: isReview ? "review" : "needs_input",
    state,
    createdAt: notification.timestamp,
    updatedAt: notification.timestamp,
    ...(state === "resolved" ? { resolvedAt: notification.timestamp } : {}),
    route,
    chipEligible: true,
    ledgerEligible: true,
    dedupeKey: `notification:${notification.id}`,
  };
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

function normalizeAttentionRecord(record: AttentionRecord, leaderSessionId: string): AttentionRecord {
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

function routeForNotification(notification: SessionNotification): AttentionRecord["route"] {
  const target = normalizeRouteTarget(notification.threadKey ?? notification.questId ?? MAIN_THREAD_KEY);
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

function attentionRecordToMessage(record: AttentionRecord): ChatMessage {
  return {
    id: `attention-ledger:${record.id}`,
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
