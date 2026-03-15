#!/usr/bin/env bun

import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { loadRecording, type Recording } from "../server/replay.js";
import { summarizeRecordings } from "../server/recording-traffic-report.js";

interface CliOptions {
  dir: string;
  sessionId: string | null;
  since: number | null;
  until: number | null;
}

function parseTime(value: string, flag: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid ${flag} timestamp: ${value}`);
  }
  return parsed;
}

function parseArgs(argv: string[]): CliOptions {
  let dir = process.env.COMPANION_RECORDINGS_DIR || "/tmp/companion-recordings";
  let sessionId: string | null = null;
  let since: number | null = null;
  let until: number | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dir") {
      dir = argv[++i] || dir;
    } else if (arg === "--session") {
      sessionId = argv[++i] || null;
    } else if (arg === "--since") {
      since = parseTime(argv[++i] || "", "--since");
    } else if (arg === "--until") {
      until = parseTime(argv[++i] || "", "--until");
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: bun web/bin/traffic-report.ts [--dir DIR] [--session SESSION_ID] [--since ISO] [--until ISO]",
          "",
          "Summarizes raw Takode recording files into browser/CLI byte totals and message-type breakdowns.",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { dir, sessionId, since, until };
}

function withinWindow(recording: Recording, options: CliOptions): boolean {
  if (options.sessionId && recording.header.session_id !== options.sessionId) {
    return false;
  }
  const firstEntryAt = recording.entries[0]?.ts ?? recording.header.started_at;
  const lastEntryAt = recording.entries[recording.entries.length - 1]?.ts ?? recording.header.started_at;
  if (options.since !== null && lastEntryAt < options.since) {
    return false;
  }
  if (options.until !== null && firstEntryAt > options.until) {
    return false;
  }
  return true;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const filenames = (await readdir(options.dir)).filter((name) => name.endsWith(".jsonl")).sort();

  const recordings = filenames
    .map((name) => {
      const path = join(options.dir, name);
      try {
        return loadRecording(path);
      } catch (err) {
        console.warn(`[traffic-report] Skipping ${basename(path)}: ${(err as Error).message}`);
        return null;
      }
    })
    .filter((recording): recording is Recording => Boolean(recording))
    .filter((recording) => withinWindow(recording, options));

  const summary = summarizeRecordings(recordings);
  console.log(
    JSON.stringify(
      {
        directory: options.dir,
        sessionId: options.sessionId,
        since: options.since,
        until: options.until,
        ...summary,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(`[traffic-report] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
