import { mkdirSync, appendFileSync } from "node:fs";
import { readdir, stat, unlink, appendFile, readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BackendType } from "./session-types.js";

const DEFAULT_MAX_LINES = 500_000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day
/** Flush buffered entries after this many milliseconds of inactivity. */
const FLUSH_INTERVAL_MS = 200;
/** Flush when the buffer reaches this many entries. */
const FLUSH_THRESHOLD = 50;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RecordingHeader {
  _header: true;
  version: 1;
  session_id: string;
  backend_type: BackendType;
  started_at: number;
  cwd: string;
}

export type RecordingDirection = "in" | "out" | "internal";
export type RecordingChannel = "cli" | "browser" | "server";

export interface RecordingEntry {
  ts: number;
  dir: RecordingDirection;
  raw: string;
  ch: RecordingChannel;
}

export interface RecordingFileMeta {
  filename: string;
  sessionId: string;
  backendType: string;
  startedAt: string;
  /** Number of lines in the file (header + entries). */
  lines: number;
}

// ─── SessionRecorder ─────────────────────────────────────────────────────────

/**
 * Writes raw messages for a single session to a JSONL file.
 * First line is a header with session metadata; subsequent lines are entries.
 * Tracks its own line count so the manager can enforce the global limit.
 *
 * Uses buffered async writes: entries are queued in memory and flushed to disk
 * periodically (every FLUSH_INTERVAL_MS) or when the buffer reaches
 * FLUSH_THRESHOLD entries. This prevents blocking the event loop on slow
 * filesystems (e.g. NFS).
 */
export class SessionRecorder {
  readonly filePath: string;
  private closed = false;
  /** Number of lines written (1 for the header at construction). */
  lineCount = 1;
  /** In-memory buffer of serialized JSONL lines waiting to be flushed. */
  private buffer: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;

  constructor(sessionId: string, backendType: BackendType, cwd: string, outputDir: string) {
    const ts = new Date().toISOString().replace(/:/g, "-");
    const suffix = randomBytes(3).toString("hex");
    const filename = `${sessionId}_${backendType}_${ts}_${suffix}.jsonl`;
    this.filePath = join(outputDir, filename);

    const header: RecordingHeader = {
      _header: true,
      version: 1,
      session_id: sessionId,
      backend_type: backendType,
      started_at: Date.now(),
      cwd,
    };
    // Header write is sync (cold path, once per session) to ensure file exists
    // before any async appends.
    appendFileSync(this.filePath, JSON.stringify(header) + "\n"); // sync-ok: cold path, once per recording session
  }

  record(dir: RecordingDirection, raw: string, channel: RecordingChannel): void {
    if (this.closed) return;
    const entry: RecordingEntry = {
      ts: Date.now(),
      dir,
      raw,
      ch: channel,
    };
    this.buffer.push(JSON.stringify(entry) + "\n");
    this.lineCount++;

    if (this.buffer.length >= FLUSH_THRESHOLD) {
      this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  /** Flush buffered entries to disk (async, non-blocking). */
  flush(): void {
    if (this.buffer.length === 0 || this.flushing) return;
    this.cancelFlushTimer();

    const chunk = this.buffer.join("");
    this.buffer = [];
    this.flushing = true;

    appendFile(this.filePath, chunk)
      .catch(() => {
        // Never throw — recording must not disrupt normal operation
      })
      .finally(() => {
        this.flushing = false;
        // If more entries accumulated while we were flushing, schedule another
        if (this.buffer.length > 0 && !this.closed) {
          this.scheduleFlush();
        }
      });
  }

  close(): void {
    this.closed = true;
    this.flush(); // Final flush of any remaining entries
    this.cancelFlushTimer();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, FLUSH_INTERVAL_MS);
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  private cancelFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

// ─── RecorderManager ─────────────────────────────────────────────────────────

/**
 * Manages recording for all sessions.
 *
 * Always enabled by default. Disable explicitly with COMPANION_RECORD=0.
 *
 * Default recordings directory is `$TMPDIR/companion-recordings/` — recordings
 * are ephemeral debugging data and benefit from fast local storage. Override
 * with COMPANION_RECORDINGS_DIR for persistent storage.
 *
 * Automatic rotation: when total lines across all recording files exceed
 * maxLines (default 500 000, override with COMPANION_RECORDINGS_MAX_LINES),
 * the oldest files are deleted until we're back under the limit.
 */
export class RecorderManager {
  private globalEnabled: boolean;
  private recordingsDir: string;
  private maxLines: number;
  private perSessionEnabled = new Set<string>();
  private perSessionDisabled = new Set<string>();
  private recorders = new Map<string, SessionRecorder>();
  private dirCreated = false;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options?: {
    globalEnabled?: boolean;
    recordingsDir?: string;
    maxLines?: number;
  }) {
    this.globalEnabled = options?.globalEnabled ?? RecorderManager.resolveEnabled();
    this.recordingsDir =
      options?.recordingsDir ?? process.env.COMPANION_RECORDINGS_DIR ?? join(tmpdir(), "companion-recordings");
    this.maxLines = options?.maxLines ?? (Number(process.env.COMPANION_RECORDINGS_MAX_LINES) || DEFAULT_MAX_LINES);

    if (this.globalEnabled) {
      // Run cleanup at startup (async, non-blocking) and periodically
      this.cleanup();
      this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
      if (this.cleanupTimer.unref) this.cleanupTimer.unref();
    }
  }

  /**
   * Always on unless explicitly disabled with COMPANION_RECORD=0|false.
   */
  private static resolveEnabled(): boolean {
    const env = process.env.COMPANION_RECORD;
    if (env === "0" || env === "false") return false;
    return true;
  }

  isGloballyEnabled(): boolean {
    return this.globalEnabled;
  }

  getRecordingsDir(): string {
    return this.recordingsDir;
  }

  getMaxLines(): number {
    return this.maxLines;
  }

  isRecording(sessionId: string): boolean {
    if (this.perSessionDisabled.has(sessionId)) return false;
    return this.globalEnabled || this.perSessionEnabled.has(sessionId);
  }

  enableForSession(sessionId: string): void {
    this.perSessionDisabled.delete(sessionId);
    this.perSessionEnabled.add(sessionId);
  }

  disableForSession(sessionId: string): void {
    this.perSessionEnabled.delete(sessionId);
    this.perSessionDisabled.add(sessionId);
    this.stopRecording(sessionId);
  }

  /**
   * Record a raw message. No-op if recording is disabled for this session.
   * Lazily creates the SessionRecorder on first call.
   */
  record(
    sessionId: string,
    dir: RecordingDirection,
    raw: string,
    channel: RecordingChannel,
    backendType: BackendType,
    cwd: string,
  ): void {
    if (!this.isRecording(sessionId)) return;

    let recorder = this.recorders.get(sessionId);
    if (!recorder) {
      this.ensureDir();
      recorder = new SessionRecorder(sessionId, backendType, cwd, this.recordingsDir);
      this.recorders.set(sessionId, recorder);
    }
    recorder.record(dir, raw, channel);
  }

  /**
   * Record a server-side event (e.g. generation state transition, relaunch decision).
   * Written to the same JSONL file as protocol messages but with ch:"server" and dir:"internal".
   */
  recordServerEvent(
    sessionId: string,
    event: string,
    data?: Record<string, unknown>,
    backendType: BackendType = "claude",
    cwd: string = "",
  ): void {
    if (!this.isRecording(sessionId)) return;

    let recorder = this.recorders.get(sessionId);
    if (!recorder) {
      this.ensureDir();
      recorder = new SessionRecorder(sessionId, backendType, cwd, this.recordingsDir);
      this.recorders.set(sessionId, recorder);
    }
    const payload = JSON.stringify({ event, ...data });
    recorder.record("internal", payload, "server");
  }

  stopRecording(sessionId: string): void {
    const recorder = this.recorders.get(sessionId);
    if (recorder) {
      recorder.close();
      this.recorders.delete(sessionId);
    }
  }

  getRecordingStatus(sessionId: string): { filePath?: string } {
    const recorder = this.recorders.get(sessionId);
    return recorder ? { filePath: recorder.filePath } : {};
  }

  /** List all recording files with metadata. Async to avoid blocking on slow FS. */
  async listRecordings(): Promise<RecordingFileMeta[]> {
    try {
      const files = await readdir(this.recordingsDir);
      const results: RecordingFileMeta[] = [];
      for (const filename of files) {
        if (!filename.endsWith(".jsonl")) continue;
        // Format: {sessionId}_{backendType}_{ISO-timestamp}_{suffix}.jsonl
        const withoutExt = filename.replace(/\.jsonl$/, "");
        const firstUnderscore = withoutExt.indexOf("_");
        const secondUnderscore = withoutExt.indexOf("_", firstUnderscore + 1);
        if (firstUnderscore === -1 || secondUnderscore === -1) {
          results.push({ filename, sessionId: "", backendType: "", startedAt: "", lines: 0 });
          continue;
        }
        const lines = await countFileLines(join(this.recordingsDir, filename));
        results.push({
          filename,
          sessionId: withoutExt.substring(0, firstUnderscore),
          backendType: withoutExt.substring(firstUnderscore + 1, secondUnderscore),
          startedAt: withoutExt.substring(secondUnderscore + 1),
          lines,
        });
      }
      return results;
    } catch {
      return [];
    }
  }

  closeAll(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const [, recorder] of this.recorders) {
      recorder.close();
    }
    this.recorders.clear();
  }

  /**
   * Delete oldest recording files until total lines are under maxLines.
   * Skips files that belong to active (currently recording) sessions.
   * Fully async to avoid blocking on slow filesystems.
   */
  async cleanup(): Promise<number> {
    try {
      this.ensureDir();
      const files = (await readdir(this.recordingsDir)).filter((f) => f.endsWith(".jsonl"));
      if (files.length === 0) return 0;

      // Build list with line counts and mtime, sorted oldest-first
      const activeFiles = new Set<string>();
      for (const rec of this.recorders.values()) {
        activeFiles.add(rec.filePath);
      }

      const entries: { filename: string; path: string; lines: number; mtimeMs: number }[] = [];
      let totalLines = 0;

      for (const filename of files) {
        const fullPath = join(this.recordingsDir, filename);
        const lines = await countFileLines(fullPath);
        let mtimeMs = 0;
        try {
          mtimeMs = (await stat(fullPath)).mtimeMs;
        } catch {
          continue;
        }
        entries.push({ filename, path: fullPath, lines, mtimeMs });
        totalLines += lines;
      }

      if (totalLines <= this.maxLines) return 0;

      // Sort oldest first (lowest mtime = oldest)
      entries.sort((a, b) => a.mtimeMs - b.mtimeMs);

      let deleted = 0;
      for (const entry of entries) {
        if (totalLines <= this.maxLines) break;
        // Don't delete files that are actively being written to
        if (activeFiles.has(entry.path)) continue;
        try {
          await unlink(entry.path);
          totalLines -= entry.lines;
          deleted++;
        } catch {
          // File may have been removed concurrently
        }
      }

      if (deleted > 0) {
        console.log(`[recorder] Cleanup: deleted ${deleted} old recording(s), ${totalLines} lines remaining`);
      }
      return deleted;
    } catch {
      return 0;
    }
  }

  private ensureDir(): void {
    if (this.dirCreated) return;
    mkdirSync(this.recordingsDir, { recursive: true });
    this.dirCreated = true;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Count newlines in a file. Async to avoid blocking on slow filesystems. */
async function countFileLines(path: string): Promise<number> {
  try {
    const buf = await readFile(path);
    let count = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a) count++;
    }
    return count;
  } catch {
    return 0;
  }
}
