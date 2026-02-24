/**
 * Lightweight performance tracer for the Companion server.
 *
 * Provides three zero-file-I/O profiling capabilities:
 * 1. Event loop lag detection — measures actual vs expected setTimeout delays
 * 2. HTTP request duration tracking — Hono middleware recording slow requests
 * 3. WebSocket message duration tracking — records slow message handlers
 *
 * All data is stored in fixed-size in-memory ring buffers, queryable via
 * REST endpoints at /api/perf/*. Periodic console summaries provide at-a-glance
 * server health without any file I/O.
 */

// ─── Ring Buffer ─────────────────────────────────────────────────────────────

/** Fixed-size circular buffer that overwrites oldest entries when full. */
export class RingBuffer<T> {
  private items: (T | undefined)[];
  private head = 0;
  count = 0;

  constructor(private capacity: number) {
    this.items = new Array(capacity);
  }

  push(item: T): void {
    this.items[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /** Return items in chronological order (oldest first). */
  toArray(): T[] {
    if (this.count === 0) return [];
    const result: T[] = [];
    const start = this.count < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.count; i++) {
      result.push(this.items[(start + i) % this.capacity]!);
    }
    return result;
  }

  /** Return the N most recent items (newest first). */
  recent(n: number): T[] {
    const arr = this.toArray();
    return arr.slice(-n).reverse();
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
    this.items = new Array(this.capacity);
  }
}

// ─── Event Types ─────────────────────────────────────────────────────────────

export interface LagEvent {
  ts: number;       // epoch ms
  lagMs: number;    // actual delay beyond expected
}

export interface SlowRequestEvent {
  ts: number;
  method: string;
  path: string;
  ms: number;
}

export interface SlowWsEvent {
  ts: number;
  sessionId: string;
  dir: "cli" | "browser";
  msgType: string;
  ms: number;
}

export interface PerfSummary {
  uptimeMs: number;
  lag: {
    count: number;
    maxMs: number;
    avgMs: number;
    recent: LagEvent[];
  };
  http: {
    slowCount: number;
    maxMs: number;
    recent: SlowRequestEvent[];
  };
  ws: {
    slowCount: number;
    maxMs: number;
    recent: SlowWsEvent[];
  };
  memory: {
    heapUsedMB: number;
    rssMB: number;
  };
}

// ─── PerfTracer ──────────────────────────────────────────────────────────────

const DEFAULT_LAG_CHECK_INTERVAL_MS = 200;
const DEFAULT_LAG_THRESHOLD_MS = 20;
const DEFAULT_HTTP_SLOW_THRESHOLD_MS = 50;
const DEFAULT_WS_SLOW_THRESHOLD_MS = 50;
const DEFAULT_SUMMARY_INTERVAL_MS = 60_000;

const LAG_BUFFER_SIZE = 200;
const HTTP_BUFFER_SIZE = 200;
const WS_BUFFER_SIZE = 200;

export class PerfTracer {
  private lagBuffer = new RingBuffer<LagEvent>(LAG_BUFFER_SIZE);
  private httpBuffer = new RingBuffer<SlowRequestEvent>(HTTP_BUFFER_SIZE);
  private wsBuffer = new RingBuffer<SlowWsEvent>(WS_BUFFER_SIZE);

  private lagCheckInterval: ReturnType<typeof setInterval> | null = null;
  private summaryInterval: ReturnType<typeof setInterval> | null = null;
  private startTime = Date.now();

  // Cumulative counters (survive ring buffer overflow)
  private totalLagCount = 0;
  private totalLagMaxMs = 0;
  private totalLagSumMs = 0;
  private totalHttpSlowCount = 0;
  private totalHttpMaxMs = 0;
  private totalWsSlowCount = 0;
  private totalWsMaxMs = 0;

  // Interval counters (reset each summary period)
  private periodLagCount = 0;
  private periodLagMaxMs = 0;
  private periodHttpSlowCount = 0;
  private periodHttpMaxMs = 0;
  private periodWsSlowCount = 0;
  private periodWsMaxMs = 0;

  lagThresholdMs: number;
  httpSlowThresholdMs: number;
  wsSlowThresholdMs: number;

  constructor(options?: {
    lagThresholdMs?: number;
    httpSlowThresholdMs?: number;
    wsSlowThresholdMs?: number;
  }) {
    this.lagThresholdMs = options?.lagThresholdMs ?? DEFAULT_LAG_THRESHOLD_MS;
    this.httpSlowThresholdMs = options?.httpSlowThresholdMs ?? DEFAULT_HTTP_SLOW_THRESHOLD_MS;
    this.wsSlowThresholdMs = options?.wsSlowThresholdMs ?? DEFAULT_WS_SLOW_THRESHOLD_MS;
  }

  // ─── Event Loop Lag Monitor ──────────────────────────────────────────

  startLagMonitor(intervalMs = DEFAULT_LAG_CHECK_INTERVAL_MS): void {
    if (this.lagCheckInterval) return;
    let lastTick = performance.now();
    this.lagCheckInterval = setInterval(() => {
      const now = performance.now();
      const gap = now - lastTick;
      const lag = gap - intervalMs;
      if (lag > this.lagThresholdMs) {
        this.recordEventLoopLag(lag);
      }
      lastTick = now;
    }, intervalMs);
    if (this.lagCheckInterval.unref) this.lagCheckInterval.unref();
  }

  stopLagMonitor(): void {
    if (this.lagCheckInterval) {
      clearInterval(this.lagCheckInterval);
      this.lagCheckInterval = null;
    }
  }

  /** Start periodic console summary logging. */
  startSummaryLogging(intervalMs = DEFAULT_SUMMARY_INTERVAL_MS): void {
    if (this.summaryInterval) return;
    this.summaryInterval = setInterval(() => this.logSummary(), intervalMs);
    if (this.summaryInterval.unref) this.summaryInterval.unref();
  }

  stopSummaryLogging(): void {
    if (this.summaryInterval) {
      clearInterval(this.summaryInterval);
      this.summaryInterval = null;
    }
  }

  // ─── Record Events ───────────────────────────────────────────────────

  recordEventLoopLag(lagMs: number): void {
    const event: LagEvent = { ts: Date.now(), lagMs: Math.round(lagMs) };
    this.lagBuffer.push(event);
    this.totalLagCount++;
    this.totalLagSumMs += lagMs;
    if (lagMs > this.totalLagMaxMs) this.totalLagMaxMs = lagMs;
    this.periodLagCount++;
    if (lagMs > this.periodLagMaxMs) this.periodLagMaxMs = lagMs;
    // Log significant lag events immediately
    if (lagMs > 200) {
      console.warn(`[perf] ⚠ Event loop blocked for ${Math.round(lagMs)}ms`);
    }
  }

  recordSlowRequest(method: string, path: string, ms: number): void {
    const event: SlowRequestEvent = { ts: Date.now(), method, path, ms: Math.round(ms) };
    this.httpBuffer.push(event);
    this.totalHttpSlowCount++;
    if (ms > this.totalHttpMaxMs) this.totalHttpMaxMs = ms;
    this.periodHttpSlowCount++;
    if (ms > this.periodHttpMaxMs) this.periodHttpMaxMs = ms;
  }

  recordSlowWsMessage(sessionId: string, dir: "cli" | "browser", msgType: string, ms: number): void {
    const event: SlowWsEvent = { ts: Date.now(), sessionId, dir, msgType, ms: Math.round(ms) };
    this.wsBuffer.push(event);
    this.totalWsSlowCount++;
    if (ms > this.totalWsMaxMs) this.totalWsMaxMs = ms;
    this.periodWsSlowCount++;
    if (ms > this.periodWsMaxMs) this.periodWsMaxMs = ms;
  }

  // ─── Query ───────────────────────────────────────────────────────────

  getSummary(): PerfSummary {
    const mem = process.memoryUsage();
    return {
      uptimeMs: Date.now() - this.startTime,
      lag: {
        count: this.totalLagCount,
        maxMs: Math.round(this.totalLagMaxMs),
        avgMs: this.totalLagCount > 0 ? Math.round(this.totalLagSumMs / this.totalLagCount) : 0,
        recent: this.lagBuffer.recent(10),
      },
      http: {
        slowCount: this.totalHttpSlowCount,
        maxMs: Math.round(this.totalHttpMaxMs),
        recent: this.httpBuffer.recent(10),
      },
      ws: {
        slowCount: this.totalWsSlowCount,
        maxMs: Math.round(this.totalWsMaxMs),
        recent: this.wsBuffer.recent(10),
      },
      memory: {
        heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
        rssMB: Math.round(mem.rss / 1024 / 1024),
      },
    };
  }

  getLagEvents(limit = 50): LagEvent[] {
    return this.lagBuffer.recent(limit);
  }

  getSlowRequests(limit = 50): SlowRequestEvent[] {
    return this.httpBuffer.recent(limit);
  }

  getSlowWsMessages(limit = 50): SlowWsEvent[] {
    return this.wsBuffer.recent(limit);
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────

  reset(): void {
    this.lagBuffer.clear();
    this.httpBuffer.clear();
    this.wsBuffer.clear();
    this.totalLagCount = this.totalLagMaxMs = this.totalLagSumMs = 0;
    this.totalHttpSlowCount = this.totalHttpMaxMs = 0;
    this.totalWsSlowCount = this.totalWsMaxMs = 0;
    this.periodLagCount = this.periodLagMaxMs = 0;
    this.periodHttpSlowCount = this.periodHttpMaxMs = 0;
    this.periodWsSlowCount = this.periodWsMaxMs = 0;
    this.startTime = Date.now();
  }

  stop(): void {
    this.stopLagMonitor();
    this.stopSummaryLogging();
  }

  // ─── Console Summary ─────────────────────────────────────────────────

  private logSummary(): void {
    const mem = process.memoryUsage();
    const heapMB = Math.round(mem.heapUsed / 1024 / 1024);

    const parts: string[] = [];
    if (this.periodLagCount > 0) {
      parts.push(`lag: max=${Math.round(this.periodLagMaxMs)}ms count=${this.periodLagCount}`);
    }
    if (this.periodHttpSlowCount > 0) {
      parts.push(`http: slow=${this.periodHttpSlowCount} max=${Math.round(this.periodHttpMaxMs)}ms`);
    }
    if (this.periodWsSlowCount > 0) {
      parts.push(`ws: slow=${this.periodWsSlowCount} max=${Math.round(this.periodWsMaxMs)}ms`);
    }
    parts.push(`mem: ${heapMB}MB`);

    if (this.periodLagCount > 0 || this.periodHttpSlowCount > 0 || this.periodWsSlowCount > 0) {
      console.log(`[perf] ${parts.join(" | ")}`);
    }

    // Reset period counters
    this.periodLagCount = this.periodLagMaxMs = 0;
    this.periodHttpSlowCount = this.periodHttpMaxMs = 0;
    this.periodWsSlowCount = this.periodWsMaxMs = 0;
  }
}
