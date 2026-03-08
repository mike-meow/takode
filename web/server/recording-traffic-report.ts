import type { Recording } from "./replay.js";
import type { RecordingEntry } from "./recorder.js";
import { getTrafficMessageType } from "./traffic-stats.js";

export interface RecordingTrafficTotals {
  messages: number;
  payloadBytes: number;
}

export interface RecordingTrafficBucket extends RecordingTrafficTotals {
  channel: RecordingEntry["ch"];
  direction: RecordingEntry["dir"];
  messageType: string;
}

export interface RecordingTrafficChannelTotals extends RecordingTrafficTotals {
  channel: RecordingEntry["ch"];
  direction: RecordingEntry["dir"];
}

export interface RecordingTrafficSessionSummary {
  sessionId: string;
  totals: RecordingTrafficChannelTotals[];
}

export interface RecordingTrafficSummary {
  filesProcessed: number;
  entriesProcessed: number;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  totals: RecordingTrafficChannelTotals[];
  buckets: RecordingTrafficBucket[];
  sessions: RecordingTrafficSessionSummary[];
}

interface IndexedTotals extends RecordingTrafficTotals {}

function createTotals(): IndexedTotals {
  return { messages: 0, payloadBytes: 0 };
}

function safeMessageType(raw: string): string {
  try {
    return getTrafficMessageType(JSON.parse(raw) as Record<string, unknown>);
  } catch {
    return "invalid_json";
  }
}

function accumulate(
  index: Map<string, IndexedTotals>,
  key: string,
  payloadBytes: number,
): void {
  const bucket = index.get(key) ?? createTotals();
  bucket.messages += 1;
  bucket.payloadBytes += payloadBytes;
  index.set(key, bucket);
}

function expandEntryPayload(entry: RecordingEntry): Array<{ messageType: string; payloadBytes: number }> {
  const raw = entry.raw;
  if (entry.ch !== "cli") {
    return [{ messageType: safeMessageType(raw), payloadBytes: Buffer.byteLength(raw, "utf-8") }];
  }

  const lines = raw.split("\n").filter((line: string) => line.trim().length > 0);
  if (lines.length <= 1) {
    return [{ messageType: safeMessageType(raw), payloadBytes: Buffer.byteLength(raw, "utf-8") }];
  }

  return lines.map((line: string) => ({
    messageType: safeMessageType(line),
    payloadBytes: Buffer.byteLength(line, "utf-8"),
  }));
}

export function summarizeRecordings(recordings: Recording[]): RecordingTrafficSummary {
  const totalsIndex = new Map<string, IndexedTotals>();
  const bucketIndex = new Map<string, IndexedTotals>();
  const sessionIndex = new Map<string, Map<string, IndexedTotals>>();
  let entriesProcessed = 0;
  let firstTimestamp: number | null = null;
  let lastTimestamp: number | null = null;

  for (const recording of recordings) {
    const sessionTotals = sessionIndex.get(recording.header.session_id) ?? new Map<string, IndexedTotals>();
    for (const entry of recording.entries) {
      entriesProcessed += 1;
      firstTimestamp = firstTimestamp === null ? entry.ts : Math.min(firstTimestamp, entry.ts);
      lastTimestamp = lastTimestamp === null ? entry.ts : Math.max(lastTimestamp, entry.ts);

      const payloads = expandEntryPayload(entry);
      for (const payload of payloads) {
        const totalsKey = `${entry.ch}:${entry.dir}`;
        const bucketKey = `${entry.ch}:${entry.dir}:${payload.messageType}`;
        accumulate(totalsIndex, totalsKey, payload.payloadBytes);
        accumulate(bucketIndex, bucketKey, payload.payloadBytes);
        accumulate(sessionTotals, totalsKey, payload.payloadBytes);
      }
    }
    sessionIndex.set(recording.header.session_id, sessionTotals);
  }

  const totals = Array.from(totalsIndex.entries())
    .map(([key, value]) => {
      const [channel, direction] = key.split(":") as [RecordingEntry["ch"], RecordingEntry["dir"]];
      return { channel, direction, ...value };
    })
    .sort((a, b) => b.payloadBytes - a.payloadBytes);

  const buckets = Array.from(bucketIndex.entries())
    .map(([key, value]) => {
      const [channel, direction, ...rest] = key.split(":");
      return {
        channel: channel as RecordingEntry["ch"],
        direction: direction as RecordingEntry["dir"],
        messageType: rest.join(":"),
        ...value,
      };
    })
    .sort((a, b) => b.payloadBytes - a.payloadBytes);

  const sessions = Array.from(sessionIndex.entries())
    .map(([sessionId, totalsByChannel]) => ({
      sessionId,
      totals: Array.from(totalsByChannel.entries())
        .map(([key, value]) => {
          const [channel, direction] = key.split(":") as [RecordingEntry["ch"], RecordingEntry["dir"]];
          return { channel, direction, ...value };
        })
        .sort((a, b) => b.payloadBytes - a.payloadBytes),
    }))
    .sort((a, b) => {
      const aBytes = a.totals.reduce((sum, item) => sum + item.payloadBytes, 0);
      const bBytes = b.totals.reduce((sum, item) => sum + item.payloadBytes, 0);
      return bBytes - aBytes;
    });

  return {
    filesProcessed: recordings.length,
    entriesProcessed,
    firstTimestamp,
    lastTimestamp,
    totals,
    buckets,
    sessions,
  };
}
