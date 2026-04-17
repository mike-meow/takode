const PERF_WINDOW_KEY = "__TAKODE_PERF__";
const MAX_CAPTURED_ENTRIES = 500;

type SupportedPerfEntryType = "longtask" | "event" | "long-animation-frame";

export interface BrowserPerfEntryRecord {
  entryType: string;
  name: string;
  startTime: number;
  duration: number;
  routeHash: string;
  capturedAt: number;
  processingStart?: number;
  processingEnd?: number;
  interactionId?: number;
  renderStart?: number;
  styleAndLayoutStart?: number;
  blockingDuration?: number;
}

export interface BrowserPerfCaptureSummary {
  totalEntries: number;
  droppedEntries: number;
  byType: Record<string, { count: number; totalDuration: number; maxDuration: number }>;
}

export interface BrowserPerfCaptureSnapshot {
  label: string | null;
  startedAt: number;
  startedAtEpochMs: number;
  endedAt: number | null;
  endedAtEpochMs: number | null;
  supportedEntryTypes: SupportedPerfEntryType[];
  entries: BrowserPerfEntryRecord[];
  summary: BrowserPerfCaptureSummary;
}

export interface BrowserPerfDebugState {
  active: boolean;
  supportedEntryTypes: SupportedPerfEntryType[];
  capture: BrowserPerfCaptureSnapshot | null;
}

export interface BrowserPerfDebugHandle {
  start: (options?: { label?: string | null }) => BrowserPerfDebugState;
  stop: () => BrowserPerfDebugState;
  read: () => BrowserPerfDebugState;
  clear: () => void;
}

interface MutableCaptureState {
  label: string | null;
  startedAt: number;
  startedAtEpochMs: number;
  endedAt: number | null;
  endedAtEpochMs: number | null;
  supportedEntryTypes: SupportedPerfEntryType[];
  entries: BrowserPerfEntryRecord[];
  droppedEntries: number;
}

interface PerfObserverLike {
  observe: (options: Record<string, unknown>) => void;
  disconnect: () => void;
}

type PerfObserverCtor = new (callback: (list: { getEntries(): PerformanceEntry[] }) => void) => PerfObserverLike;

function getSupportedEntryTypes(): SupportedPerfEntryType[] {
  if (typeof PerformanceObserver === "undefined") return [];
  const ctor = PerformanceObserver as typeof PerformanceObserver & { supportedEntryTypes?: string[] };
  const supported = Array.isArray(ctor.supportedEntryTypes) ? ctor.supportedEntryTypes : [];
  return ["longtask", "event", "long-animation-frame"].filter((type): type is SupportedPerfEntryType =>
    supported.includes(type),
  );
}

function createSummary(capture: MutableCaptureState | null): BrowserPerfCaptureSummary {
  const byType: BrowserPerfCaptureSummary["byType"] = {};
  for (const entry of capture?.entries ?? []) {
    const current = byType[entry.entryType] ?? { count: 0, totalDuration: 0, maxDuration: 0 };
    current.count += 1;
    current.totalDuration += entry.duration;
    current.maxDuration = Math.max(current.maxDuration, entry.duration);
    byType[entry.entryType] = current;
  }
  return {
    totalEntries: capture?.entries.length ?? 0,
    droppedEntries: capture?.droppedEntries ?? 0,
    byType,
  };
}

function getCurrentRouteHash(): string {
  if (typeof window === "undefined") return "#/";
  return window.location.hash || "#/";
}

function readNumberField(entry: PerformanceEntry, field: string): number | undefined {
  const value = (entry as unknown as Record<string, unknown>)[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function serializeEntry(entry: PerformanceEntry): BrowserPerfEntryRecord {
  return {
    entryType: entry.entryType,
    name: entry.name,
    startTime: entry.startTime,
    duration: entry.duration,
    routeHash: getCurrentRouteHash(),
    capturedAt: Date.now(),
    ...(entry.entryType === "event"
      ? {
          processingStart: readNumberField(entry, "processingStart"),
          processingEnd: readNumberField(entry, "processingEnd"),
          interactionId: readNumberField(entry, "interactionId"),
        }
      : {}),
    ...(entry.entryType === "long-animation-frame"
      ? {
          renderStart: readNumberField(entry, "renderStart"),
          styleAndLayoutStart: readNumberField(entry, "styleAndLayoutStart"),
          blockingDuration: readNumberField(entry, "blockingDuration"),
        }
      : {}),
  };
}

function toSnapshot(capture: MutableCaptureState | null): BrowserPerfCaptureSnapshot | null {
  if (!capture) return null;
  return {
    label: capture.label,
    startedAt: capture.startedAt,
    startedAtEpochMs: capture.startedAtEpochMs,
    endedAt: capture.endedAt,
    endedAtEpochMs: capture.endedAtEpochMs,
    supportedEntryTypes: [...capture.supportedEntryTypes],
    entries: capture.entries.map((entry) => ({ ...entry })),
    summary: createSummary(capture),
  };
}

class BrowserPerfDebugCollector implements BrowserPerfDebugHandle {
  private capture: MutableCaptureState | null = null;
  private observers: PerfObserverLike[] = [];

  start(options?: { label?: string | null }): BrowserPerfDebugState {
    this.teardownObservers();
    const supportedEntryTypes = getSupportedEntryTypes();
    this.capture = {
      label: options?.label?.trim() || null,
      startedAt: typeof performance !== "undefined" ? performance.now() : 0,
      startedAtEpochMs: Date.now(),
      endedAt: null,
      endedAtEpochMs: null,
      supportedEntryTypes,
      entries: [],
      droppedEntries: 0,
    };

    if (typeof PerformanceObserver !== "undefined") {
      const ObserverCtor = PerformanceObserver as unknown as PerfObserverCtor;
      for (const type of supportedEntryTypes) {
        const observer = new ObserverCtor((list) => {
          const activeCapture = this.capture;
          if (!activeCapture) return;
          for (const entry of list.getEntries()) {
            if (activeCapture.entries.length >= MAX_CAPTURED_ENTRIES) {
              activeCapture.droppedEntries += 1;
              continue;
            }
            activeCapture.entries.push(serializeEntry(entry));
          }
        });
        observer.observe(type === "event" ? { type, buffered: true, durationThreshold: 16 } : { type, buffered: true });
        this.observers.push(observer);
      }
    }

    return this.read();
  }

  stop(): BrowserPerfDebugState {
    if (this.capture) {
      this.capture.endedAt = typeof performance !== "undefined" ? performance.now() : this.capture.startedAt;
      this.capture.endedAtEpochMs = Date.now();
    }
    this.teardownObservers();
    return this.read();
  }

  read(): BrowserPerfDebugState {
    return {
      active: this.capture?.endedAt == null && this.capture != null,
      supportedEntryTypes: getSupportedEntryTypes(),
      capture: toSnapshot(this.capture),
    };
  }

  clear(): void {
    this.teardownObservers();
    this.capture = null;
  }

  private teardownObservers(): void {
    for (const observer of this.observers) observer.disconnect();
    this.observers = [];
  }
}

let singleton: BrowserPerfDebugCollector | null = null;

export function getBrowserPerfDebugHandle(): BrowserPerfDebugHandle {
  if (!singleton) singleton = new BrowserPerfDebugCollector();
  return singleton;
}

export function installBrowserPerfDebugHooks(): void {
  if (typeof window === "undefined") return;
  const debugWindow = window as Window & { [PERF_WINDOW_KEY]?: BrowserPerfDebugHandle };
  if (debugWindow[PERF_WINDOW_KEY]) return;
  debugWindow[PERF_WINDOW_KEY] = getBrowserPerfDebugHandle();
}

export function resetBrowserPerfDebugForTest(): void {
  singleton?.clear();
  singleton = null;
  if (typeof window === "undefined") return;
  const debugWindow = window as Window & { [PERF_WINDOW_KEY]?: BrowserPerfDebugHandle };
  delete debugWindow[PERF_WINDOW_KEY];
}
