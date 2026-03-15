import { describe, expect, it } from "vitest";
import { summarizeRecordings } from "./recording-traffic-report.js";
import type { Recording } from "./replay.js";

function makeRecording(sessionId: string, entries: Recording["entries"]): Recording {
  return {
    header: {
      _header: true,
      version: 1,
      session_id: sessionId,
      backend_type: "claude",
      started_at: 1000,
      cwd: "/repo",
    },
    entries,
  };
}

describe("summarizeRecordings", () => {
  it("aggregates totals by channel, direction, and message type", () => {
    const summary = summarizeRecordings([
      makeRecording("s1", [
        { ts: 1100, dir: "out", ch: "browser", raw: JSON.stringify({ type: "message_history" }) },
        { ts: 1200, dir: "out", ch: "browser", raw: JSON.stringify({ type: "history_sync" }) },
      ]),
      makeRecording("s2", [
        {
          ts: 1300,
          dir: "in",
          ch: "cli",
          raw: `${JSON.stringify({ type: "keep_alive" })}\n${JSON.stringify({ type: "result", subtype: "success" })}`,
        },
      ]),
    ]);

    expect(summary.filesProcessed).toBe(2);
    expect(summary.entriesProcessed).toBe(3);
    expect(summary.firstTimestamp).toBe(1100);
    expect(summary.lastTimestamp).toBe(1300);

    expect(summary.totals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: "browser", direction: "out", messages: 2 }),
        expect.objectContaining({ channel: "cli", direction: "in", messages: 2 }),
      ]),
    );

    expect(summary.buckets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: "browser", direction: "out", messageType: "message_history", messages: 1 }),
        expect.objectContaining({ channel: "browser", direction: "out", messageType: "history_sync", messages: 1 }),
        expect.objectContaining({ channel: "cli", direction: "in", messageType: "keep_alive", messages: 1 }),
        expect.objectContaining({ channel: "cli", direction: "in", messageType: "result.success", messages: 1 }),
      ]),
    );
  });
});
