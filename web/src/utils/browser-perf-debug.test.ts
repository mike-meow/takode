// @vitest-environment jsdom
import {
  getBrowserPerfDebugHandle,
  installBrowserPerfDebugHooks,
  resetBrowserPerfDebugForTest,
} from "./browser-perf-debug.js";

class MockPerformanceObserver {
  static supportedEntryTypes: string[] = [];
  static instances: MockPerformanceObserver[] = [];

  readonly callback: (list: { getEntries(): PerformanceEntry[] }) => void;
  observed: Record<string, unknown>[] = [];
  disconnected = false;

  constructor(callback: (list: { getEntries(): PerformanceEntry[] }) => void) {
    this.callback = callback;
    MockPerformanceObserver.instances.push(this);
  }

  observe(options: Record<string, unknown>) {
    this.observed.push(options);
  }

  disconnect() {
    this.disconnected = true;
  }
}

function emitEntries(entryType: string, entries: PerformanceEntry[]) {
  for (const instance of MockPerformanceObserver.instances) {
    if (instance.observed.some((options) => options.type === entryType)) {
      instance.callback({ getEntries: () => entries });
    }
  }
}

function makeEntry(
  entryType: string,
  overrides: Partial<
    PerformanceEntry & {
      processingStart?: number;
      processingEnd?: number;
      interactionId?: number;
      renderStart?: number;
      styleAndLayoutStart?: number;
      blockingDuration?: number;
    }
  > = {},
): PerformanceEntry {
  return {
    entryType,
    name: overrides.name ?? `${entryType}-entry`,
    startTime: overrides.startTime ?? 10,
    duration: overrides.duration ?? 60,
    toJSON: () => ({}),
    ...overrides,
  } as PerformanceEntry;
}

describe("browser perf debug collector", () => {
  beforeEach(() => {
    resetBrowserPerfDebugForTest();
    MockPerformanceObserver.instances = [];
    MockPerformanceObserver.supportedEntryTypes = ["longtask", "event", "long-animation-frame"];
    vi.stubGlobal("PerformanceObserver", MockPerformanceObserver);
    vi.spyOn(performance, "now").mockReturnValue(123);
    window.location.hash = "#/session/s1";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetBrowserPerfDebugForTest();
  });

  it("supports start stop read and clear lifecycle with json-safe summary output", () => {
    const perf = getBrowserPerfDebugHandle();

    expect(perf.read()).toEqual({
      active: false,
      supportedEntryTypes: ["longtask", "event", "long-animation-frame"],
      capture: null,
    });

    const started = perf.start({ label: "typing" });
    expect(started.active).toBe(true);
    expect(started.capture?.label).toBe("typing");

    emitEntries("longtask", [makeEntry("longtask", { name: "task-A", duration: 75 })]);

    const during = perf.read();
    expect(during.capture?.entries).toEqual([
      expect.objectContaining({
        entryType: "longtask",
        name: "task-A",
        duration: 75,
        routeHash: "#/session/s1",
      }),
    ]);
    expect(during.capture?.summary.byType.longtask).toEqual({
      count: 1,
      totalDuration: 75,
      maxDuration: 75,
    });

    const stopped = perf.stop();
    expect(stopped.active).toBe(false);
    expect(stopped.capture?.endedAt).toBe(123);
    expect(MockPerformanceObserver.instances.every((instance) => instance.disconnected)).toBe(true);

    perf.clear();
    expect(perf.read().capture).toBeNull();
  });

  it("serializes event and long-animation-frame fields when available", () => {
    const perf = getBrowserPerfDebugHandle();
    perf.start();

    emitEntries("event", [
      makeEntry("event", {
        name: "keydown",
        duration: 24,
        processingStart: 11,
        processingEnd: 35,
        interactionId: 42,
      }),
    ]);
    emitEntries("long-animation-frame", [
      makeEntry("long-animation-frame", {
        name: "frame",
        duration: 80,
        renderStart: 15,
        styleAndLayoutStart: 20,
        blockingDuration: 30,
      }),
    ]);

    const capture = perf.read().capture;
    expect(capture?.entries).toEqual([
      expect.objectContaining({
        entryType: "event",
        name: "keydown",
        processingStart: 11,
        processingEnd: 35,
        interactionId: 42,
      }),
      expect.objectContaining({
        entryType: "long-animation-frame",
        name: "frame",
        renderStart: 15,
        styleAndLayoutStart: 20,
        blockingDuration: 30,
      }),
    ]);
  });

  it("gracefully handles browsers without performance observer support", () => {
    vi.unstubAllGlobals();
    resetBrowserPerfDebugForTest();
    const perf = getBrowserPerfDebugHandle();

    const started = perf.start({ label: "unsupported" });
    expect(started.active).toBe(true);
    expect(started.supportedEntryTypes).toEqual([]);
    expect(started.capture?.supportedEntryTypes).toEqual([]);
    expect(started.capture?.entries).toEqual([]);
  });

  it("installs the global debug handle on window", () => {
    installBrowserPerfDebugHooks();

    const debugWindow = window as Window & { __TAKODE_PERF__?: unknown };
    expect(debugWindow.__TAKODE_PERF__).toEqual(
      expect.objectContaining({
        start: expect.any(Function),
        stop: expect.any(Function),
        read: expect.any(Function),
        clear: expect.any(Function),
      }),
    );
  });
});
