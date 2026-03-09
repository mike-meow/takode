export type TrafficChannel = "browser" | "cli";
export type TrafficDirection = "in" | "out";

export interface TrafficTotals {
  messages: number;
  payloadBytes: number;
  wireBytes: number;
}

export interface TrafficBucketSnapshot extends TrafficTotals {
  channel: TrafficChannel;
  direction: TrafficDirection;
  messageType: string;
  fanoutSum: number;
  maxFanout: number;
}

export interface TrafficSessionSnapshot {
  totals: TrafficTotals;
  buckets: TrafficBucketSnapshot[];
}

export interface TrafficStatsSnapshot {
  windowStartedAt: number;
  capturedAt: number;
  totals: TrafficTotals;
  buckets: TrafficBucketSnapshot[];
  sessions: Record<string, TrafficSessionSnapshot>;
  historySyncBreakdown: HistorySyncBreakdownSnapshot;
  toolResultFetches: ToolResultFetchSnapshot;
}

export interface TrafficRecord {
  sessionId: string;
  channel: TrafficChannel;
  direction: TrafficDirection;
  messageType: string;
  payloadBytes: number;
  fanout?: number;
}

export interface ToolResultFetchRecord {
  sessionId: string;
  toolUseId: string;
  payloadBytes: number;
  isError: boolean;
}

export interface ToolResultFetchTotals {
  requests: number;
  repeatedRequests: number;
  payloadBytes: number;
  errorRequests: number;
}

export interface ToolResultFetchEntrySnapshot extends ToolResultFetchTotals {
  sessionId: string;
  toolUseId: string;
  lastFetchedAt: number;
  maxPayloadBytes: number;
}

export interface ToolResultFetchSessionSnapshot extends ToolResultFetchTotals {
  tools: ToolResultFetchEntrySnapshot[];
}

export interface ToolResultFetchSnapshot {
  totals: ToolResultFetchTotals;
  sessions: Record<string, ToolResultFetchSessionSnapshot>;
  topRepeated: ToolResultFetchEntrySnapshot[];
}

export interface HistorySyncBreakdownRecord {
  sessionId: string;
  frozenDeltaBytes: number;
  hotMessagesBytes: number;
  frozenDeltaMessages: number;
  hotMessagesCount: number;
}

export interface HistorySyncBreakdownTotals {
  requests: number;
  frozenDeltaBytes: number;
  hotMessagesBytes: number;
  frozenDeltaMessages: number;
  hotMessagesCount: number;
}

export interface HistorySyncBreakdownSessionSnapshot extends HistorySyncBreakdownTotals {}

export interface HistorySyncBreakdownSnapshot {
  totals: HistorySyncBreakdownTotals;
  sessions: Record<string, HistorySyncBreakdownSessionSnapshot>;
}

interface TrafficBucket extends TrafficTotals {
  fanoutSum: number;
  maxFanout: number;
}

interface ToolResultFetchEntry extends ToolResultFetchTotals {
  lastFetchedAt: number;
  maxPayloadBytes: number;
}

function createTotals(): TrafficTotals {
  return { messages: 0, payloadBytes: 0, wireBytes: 0 };
}

function createBucket(): TrafficBucket {
  return { ...createTotals(), fanoutSum: 0, maxFanout: 0 };
}

function createHistorySyncBreakdownTotals(): HistorySyncBreakdownTotals {
  return {
    requests: 0,
    frozenDeltaBytes: 0,
    hotMessagesBytes: 0,
    frozenDeltaMessages: 0,
    hotMessagesCount: 0,
  };
}

function createToolResultFetchTotals(): ToolResultFetchTotals {
  return { requests: 0, repeatedRequests: 0, payloadBytes: 0, errorRequests: 0 };
}

function createToolResultFetchEntry(): ToolResultFetchEntry {
  return { ...createToolResultFetchTotals(), lastFetchedAt: 0, maxPayloadBytes: 0 };
}

function bucketKey(channel: TrafficChannel, direction: TrafficDirection, messageType: string): string {
  return `${channel}:${direction}:${messageType}`;
}

function sanitizeMessageType(messageType: string | null | undefined): string {
  return messageType && messageType.trim() ? messageType.trim() : "unknown";
}

function addToTotals(target: TrafficTotals, payloadBytes: number, wireBytes: number): void {
  target.messages += 1;
  target.payloadBytes += payloadBytes;
  target.wireBytes += wireBytes;
}

export function getTrafficMessageType(value: unknown): string {
  if (!value || typeof value !== "object") return "unknown";
  const record = value as Record<string, unknown>;
  if (typeof record.method === "string" && record.method.trim()) {
    return `method:${record.method.trim()}`;
  }
  if (typeof record.type === "string" && record.type.trim()) {
    const type = record.type.trim();
    if (typeof record.subtype === "string" && record.subtype.trim()) {
      return `${type}.${record.subtype.trim()}`;
    }
    return type;
  }
  if (
    Object.prototype.hasOwnProperty.call(record, "id")
    && (Object.prototype.hasOwnProperty.call(record, "result")
      || Object.prototype.hasOwnProperty.call(record, "error"))
  ) {
    return "jsonrpc_response";
  }
  return "unknown";
}

export class TrafficStatsCollector {
  private windowStartedAt = Date.now();
  private totals: TrafficTotals = createTotals();
  private buckets = new Map<string, TrafficBucket>();
  private sessionTotals = new Map<string, TrafficTotals>();
  private sessionBuckets = new Map<string, Map<string, TrafficBucket>>();
  private historySyncBreakdownTotals: HistorySyncBreakdownTotals = createHistorySyncBreakdownTotals();
  private historySyncBreakdownBySession = new Map<string, HistorySyncBreakdownTotals>();
  private toolResultFetchTotals: ToolResultFetchTotals = createToolResultFetchTotals();
  private toolResultFetchesBySession = new Map<string, Map<string, ToolResultFetchEntry>>();

  record(event: TrafficRecord): void {
    const payloadBytes = Math.max(0, Math.floor(event.payloadBytes));
    const fanout = Math.max(0, Math.floor(event.fanout ?? 1));
    const wireBytes = payloadBytes * fanout;
    const messageType = sanitizeMessageType(event.messageType);
    const globalKey = bucketKey(event.channel, event.direction, messageType);

    addToTotals(this.totals, payloadBytes, wireBytes);

    const globalBucket = this.buckets.get(globalKey) ?? createBucket();
    addToTotals(globalBucket, payloadBytes, wireBytes);
    globalBucket.fanoutSum += fanout;
    globalBucket.maxFanout = Math.max(globalBucket.maxFanout, fanout);
    this.buckets.set(globalKey, globalBucket);

    const sessionTotals = this.sessionTotals.get(event.sessionId) ?? createTotals();
    addToTotals(sessionTotals, payloadBytes, wireBytes);
    this.sessionTotals.set(event.sessionId, sessionTotals);

    const perSessionBuckets = this.sessionBuckets.get(event.sessionId) ?? new Map<string, TrafficBucket>();
    const sessionBucket = perSessionBuckets.get(globalKey) ?? createBucket();
    addToTotals(sessionBucket, payloadBytes, wireBytes);
    sessionBucket.fanoutSum += fanout;
    sessionBucket.maxFanout = Math.max(sessionBucket.maxFanout, fanout);
    perSessionBuckets.set(globalKey, sessionBucket);
    this.sessionBuckets.set(event.sessionId, perSessionBuckets);
  }

  recordHistorySyncBreakdown(event: HistorySyncBreakdownRecord): void {
    const frozenDeltaBytes = Math.max(0, Math.floor(event.frozenDeltaBytes));
    const hotMessagesBytes = Math.max(0, Math.floor(event.hotMessagesBytes));
    const frozenDeltaMessages = Math.max(0, Math.floor(event.frozenDeltaMessages));
    const hotMessagesCount = Math.max(0, Math.floor(event.hotMessagesCount));

    this.historySyncBreakdownTotals.requests += 1;
    this.historySyncBreakdownTotals.frozenDeltaBytes += frozenDeltaBytes;
    this.historySyncBreakdownTotals.hotMessagesBytes += hotMessagesBytes;
    this.historySyncBreakdownTotals.frozenDeltaMessages += frozenDeltaMessages;
    this.historySyncBreakdownTotals.hotMessagesCount += hotMessagesCount;

    const sessionTotals =
      this.historySyncBreakdownBySession.get(event.sessionId) ?? createHistorySyncBreakdownTotals();
    sessionTotals.requests += 1;
    sessionTotals.frozenDeltaBytes += frozenDeltaBytes;
    sessionTotals.hotMessagesBytes += hotMessagesBytes;
    sessionTotals.frozenDeltaMessages += frozenDeltaMessages;
    sessionTotals.hotMessagesCount += hotMessagesCount;
    this.historySyncBreakdownBySession.set(event.sessionId, sessionTotals);
  }

  recordToolResultFetch(event: ToolResultFetchRecord): void {
    const payloadBytes = Math.max(0, Math.floor(event.payloadBytes));
    const sessionEntries = this.toolResultFetchesBySession.get(event.sessionId) ?? new Map<string, ToolResultFetchEntry>();
    const existing = sessionEntries.get(event.toolUseId) ?? createToolResultFetchEntry();

    existing.requests += 1;
    if (existing.requests > 1) existing.repeatedRequests += 1;
    existing.payloadBytes += payloadBytes;
    if (event.isError) existing.errorRequests += 1;
    existing.lastFetchedAt = Date.now();
    existing.maxPayloadBytes = Math.max(existing.maxPayloadBytes, payloadBytes);
    sessionEntries.set(event.toolUseId, existing);
    this.toolResultFetchesBySession.set(event.sessionId, sessionEntries);

    this.toolResultFetchTotals.requests += 1;
    if (existing.requests > 1) this.toolResultFetchTotals.repeatedRequests += 1;
    this.toolResultFetchTotals.payloadBytes += payloadBytes;
    if (event.isError) this.toolResultFetchTotals.errorRequests += 1;
  }

  snapshot(): TrafficStatsSnapshot {
    const capturedAt = Date.now();
    const buckets = this.serializeBuckets(this.buckets);
    const sessions: Record<string, TrafficSessionSnapshot> = {};
    for (const [sessionId, totals] of this.sessionTotals) {
      sessions[sessionId] = {
        totals: { ...totals },
        buckets: this.serializeBuckets(this.sessionBuckets.get(sessionId) ?? new Map()),
      };
    }
    return {
      windowStartedAt: this.windowStartedAt,
      capturedAt,
      totals: { ...this.totals },
      buckets,
      sessions,
      historySyncBreakdown: this.serializeHistorySyncBreakdown(),
      toolResultFetches: this.serializeToolResultFetches(),
    };
  }

  reset(): void {
    this.windowStartedAt = Date.now();
    this.totals = createTotals();
    this.buckets.clear();
    this.sessionTotals.clear();
    this.sessionBuckets.clear();
    this.historySyncBreakdownTotals = createHistorySyncBreakdownTotals();
    this.historySyncBreakdownBySession.clear();
    this.toolResultFetchTotals = createToolResultFetchTotals();
    this.toolResultFetchesBySession.clear();
  }

  private serializeBuckets(source: Map<string, TrafficBucket>): TrafficBucketSnapshot[] {
    const entries: TrafficBucketSnapshot[] = [];
    for (const [key, bucket] of source) {
      const firstColon = key.indexOf(":");
      const secondColon = key.indexOf(":", firstColon + 1);
      const channel = key.slice(0, firstColon) as TrafficChannel;
      const direction = key.slice(firstColon + 1, secondColon) as TrafficDirection;
      const messageType = key.slice(secondColon + 1);
      entries.push({
        channel,
        direction,
        messageType,
        messages: bucket.messages,
        payloadBytes: bucket.payloadBytes,
        wireBytes: bucket.wireBytes,
        fanoutSum: bucket.fanoutSum,
        maxFanout: bucket.maxFanout,
      });
    }
    return entries.sort((a, b) => {
      if (b.wireBytes !== a.wireBytes) return b.wireBytes - a.wireBytes;
      if (a.channel !== b.channel) return a.channel.localeCompare(b.channel);
      if (a.direction !== b.direction) return a.direction.localeCompare(b.direction);
      return a.messageType.localeCompare(b.messageType);
    });
  }

  private serializeHistorySyncBreakdown(): HistorySyncBreakdownSnapshot {
    const sessions: Record<string, HistorySyncBreakdownSessionSnapshot> = {};
    for (const [sessionId, totals] of this.historySyncBreakdownBySession) {
      sessions[sessionId] = { ...totals };
    }
    return {
      totals: { ...this.historySyncBreakdownTotals },
      sessions,
    };
  }

  private serializeToolResultFetches(): ToolResultFetchSnapshot {
    const sessions: Record<string, ToolResultFetchSessionSnapshot> = {};
    const allTools: ToolResultFetchEntrySnapshot[] = [];

    for (const [sessionId, entries] of this.toolResultFetchesBySession) {
      const tools: ToolResultFetchEntrySnapshot[] = [];
      const totals = createToolResultFetchTotals();
      for (const [toolUseId, entry] of entries) {
        const snapshot: ToolResultFetchEntrySnapshot = {
          sessionId,
          toolUseId,
          requests: entry.requests,
          repeatedRequests: entry.repeatedRequests,
          payloadBytes: entry.payloadBytes,
          errorRequests: entry.errorRequests,
          lastFetchedAt: entry.lastFetchedAt,
          maxPayloadBytes: entry.maxPayloadBytes,
        };
        tools.push(snapshot);
        allTools.push(snapshot);
        totals.requests += entry.requests;
        totals.repeatedRequests += entry.repeatedRequests;
        totals.payloadBytes += entry.payloadBytes;
        totals.errorRequests += entry.errorRequests;
      }
      tools.sort((a, b) => {
        if (b.repeatedRequests !== a.repeatedRequests) return b.repeatedRequests - a.repeatedRequests;
        if (b.payloadBytes !== a.payloadBytes) return b.payloadBytes - a.payloadBytes;
        return a.toolUseId.localeCompare(b.toolUseId);
      });
      sessions[sessionId] = { ...totals, tools };
    }

    allTools.sort((a, b) => {
      if (b.repeatedRequests !== a.repeatedRequests) return b.repeatedRequests - a.repeatedRequests;
      if (b.payloadBytes !== a.payloadBytes) return b.payloadBytes - a.payloadBytes;
      if (a.sessionId !== b.sessionId) return a.sessionId.localeCompare(b.sessionId);
      return a.toolUseId.localeCompare(b.toolUseId);
    });

    return {
      totals: { ...this.toolResultFetchTotals },
      sessions,
      topRepeated: allTools.slice(0, 20),
    };
  }
}

export const trafficStats = new TrafficStatsCollector();
