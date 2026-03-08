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
}

export interface TrafficRecord {
  sessionId: string;
  channel: TrafficChannel;
  direction: TrafficDirection;
  messageType: string;
  payloadBytes: number;
  fanout?: number;
}

interface TrafficBucket extends TrafficTotals {
  fanoutSum: number;
  maxFanout: number;
}

function createTotals(): TrafficTotals {
  return { messages: 0, payloadBytes: 0, wireBytes: 0 };
}

function createBucket(): TrafficBucket {
  return { ...createTotals(), fanoutSum: 0, maxFanout: 0 };
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
    };
  }

  reset(): void {
    this.windowStartedAt = Date.now();
    this.totals = createTotals();
    this.buckets.clear();
    this.sessionTotals.clear();
    this.sessionBuckets.clear();
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
}

export const trafficStats = new TrafficStatsCollector();
