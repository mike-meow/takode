import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";

// SleepInhibitor uses `spawn` from node:child_process at module level.
// We mock the module so tests don't actually run caffeinate.
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

// Import after mock is set up.
const { SleepInhibitor } = await import("./sleep-inhibitor.js");

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockWsBridge(sessions: Record<string, { isGenerating: boolean }>) {
  return {
    getSession(id: string) {
      return sessions[id] ? { isGenerating: sessions[id].isGenerating } : undefined;
    },
  } as any;
}

function mockLauncher(entries: Array<{ sessionId: string; state?: string }>) {
  return {
    listSessions: () =>
      entries.map((e) => ({ sessionId: e.sessionId, state: e.state ?? "running" })),
  } as any;
}

function defaultSettings(overrides?: {
  sleepInhibitorEnabled?: boolean;
  sleepInhibitorDurationMinutes?: number;
}) {
  return {
    sleepInhibitorEnabled: false,
    sleepInhibitorDurationMinutes: 5,
    ...overrides,
  };
}

/** Create a mock ChildProcess returned by spawn. */
function mockProc() {
  return {
    on: vi.fn(),
    kill: vi.fn(),
    unref: vi.fn(),
    exitCode: null,
    signalCode: null,
  };
}

describe("SleepInhibitor", () => {
  const originalPlatform = process.platform;
  const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    // Restore platform in case a test changed it.
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  function setPlatform(p: string) {
    Object.defineProperty(process, "platform", { value: p, configurable: true });
  }

  // ── Platform guard ──────────────────────────────────────────────────

  it("is a no-op on non-macOS: start() never sets an interval or spawns", () => {
    setPlatform("linux");
    const inhibitor = new SleepInhibitor({
      wsBridge: mockWsBridge({ s1: { isGenerating: true } }),
      launcher: mockLauncher([{ sessionId: "s1" }]),
      getSettings: () => defaultSettings({ sleepInhibitorEnabled: true }),
    });

    inhibitor.start(1000);
    vi.advanceTimersByTime(5000);
    expect(spawnMock).not.toHaveBeenCalled();
    inhibitor.stop();
  });

  // ── Disabled setting ───────────────────────────────────────────────

  it("does not spawn caffeinate when disabled, even with generating sessions", () => {
    setPlatform("darwin");
    const inhibitor = new SleepInhibitor({
      wsBridge: mockWsBridge({ s1: { isGenerating: true } }),
      launcher: mockLauncher([{ sessionId: "s1" }]),
      getSettings: () => defaultSettings({ sleepInhibitorEnabled: false }),
    });

    inhibitor.start(60_000);
    expect(spawnMock).not.toHaveBeenCalled();
    inhibitor.stop();
  });

  // ── Happy path: spawns when generating ─────────────────────────────

  it("spawns caffeinate when enabled and a session is generating", () => {
    setPlatform("darwin");
    const proc = mockProc();
    spawnMock.mockReturnValue(proc);

    const inhibitor = new SleepInhibitor({
      wsBridge: mockWsBridge({ s1: { isGenerating: true } }),
      launcher: mockLauncher([{ sessionId: "s1" }]),
      getSettings: () => defaultSettings({ sleepInhibitorEnabled: true, sleepInhibitorDurationMinutes: 5 }),
    });

    inhibitor.start(60_000);

    // Should have spawned caffeinate with -t 300 (5 min * 60 sec)
    expect(spawnMock).toHaveBeenCalledWith("caffeinate", ["-t", "300"], expect.objectContaining({ stdio: "ignore" }));
    expect(proc.unref).toHaveBeenCalled();

    inhibitor.stop();
    // stop() kills the process
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  // ── No spawn when idle ─────────────────────────────────────────────

  it("does not spawn caffeinate when no sessions are generating", () => {
    setPlatform("darwin");
    const inhibitor = new SleepInhibitor({
      wsBridge: mockWsBridge({ s1: { isGenerating: false } }),
      launcher: mockLauncher([{ sessionId: "s1" }]),
      getSettings: () => defaultSettings({ sleepInhibitorEnabled: true }),
    });

    inhibitor.start(60_000);
    expect(spawnMock).not.toHaveBeenCalled();
    inhibitor.stop();
  });

  // ── Kill-before-respawn ────────────────────────────────────────────

  it("kills the old caffeinate before spawning a new one on subsequent sweeps", () => {
    setPlatform("darwin");
    const procs = [mockProc(), mockProc()];
    let callIdx = 0;
    spawnMock.mockImplementation(() => procs[callIdx++]);

    const inhibitor = new SleepInhibitor({
      wsBridge: mockWsBridge({ s1: { isGenerating: true } }),
      launcher: mockLauncher([{ sessionId: "s1" }]),
      getSettings: () => defaultSettings({ sleepInhibitorEnabled: true }),
    });

    inhibitor.start(60_000);
    // First sweep spawns procs[0]
    expect(callIdx).toBe(1);

    vi.advanceTimersByTime(60_000);
    // Should have killed procs[0] and spawned procs[1]
    expect(procs[0].kill).toHaveBeenCalledWith("SIGTERM");
    expect(callIdx).toBe(2);

    inhibitor.stop();
    expect(procs[1].kill).toHaveBeenCalledWith("SIGTERM");
  });

  // ── Duration config ────────────────────────────────────────────────

  it("converts duration in minutes to seconds for caffeinate -t argument", () => {
    setPlatform("darwin");
    spawnMock.mockReturnValue(mockProc());

    const inhibitor = new SleepInhibitor({
      wsBridge: mockWsBridge({ s1: { isGenerating: true } }),
      launcher: mockLauncher([{ sessionId: "s1" }]),
      getSettings: () => defaultSettings({ sleepInhibitorEnabled: true, sleepInhibitorDurationMinutes: 15 }),
    });

    inhibitor.start(60_000);
    expect(spawnMock).toHaveBeenCalledWith("caffeinate", ["-t", "900"], expect.any(Object));
    inhibitor.stop();
  });

  // ── Skips exited sessions ──────────────────────────────────────────

  it("skips exited sessions even if their bridge state shows generating", () => {
    setPlatform("darwin");
    const inhibitor = new SleepInhibitor({
      // Bridge says generating, but launcher says exited -- should not trigger
      wsBridge: mockWsBridge({ s1: { isGenerating: true } }),
      launcher: mockLauncher([{ sessionId: "s1", state: "exited" }]),
      getSettings: () => defaultSettings({ sleepInhibitorEnabled: true }),
    });

    inhibitor.start(60_000);
    expect(spawnMock).not.toHaveBeenCalled();
    inhibitor.stop();
  });

  // ── Spawn error handling ───────────────────────────────────────────

  it("handles caffeinate spawn error gracefully without crashing", () => {
    setPlatform("darwin");
    spawnMock.mockImplementation(() => {
      throw new Error("spawn ENOENT");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const inhibitor = new SleepInhibitor({
      wsBridge: mockWsBridge({ s1: { isGenerating: true } }),
      launcher: mockLauncher([{ sessionId: "s1" }]),
      getSettings: () => defaultSettings({ sleepInhibitorEnabled: true }),
    });

    // Should not throw
    inhibitor.start(60_000);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("caffeinate spawn error"));

    inhibitor.stop();
    warnSpy.mockRestore();
  });

  // ── Toggle off mid-run kills caffeinate ────────────────────────────

  it("kills caffeinate when feature is toggled off mid-run", () => {
    setPlatform("darwin");
    const proc = mockProc();
    spawnMock.mockReturnValue(proc);

    let enabled = true;
    const inhibitor = new SleepInhibitor({
      wsBridge: mockWsBridge({ s1: { isGenerating: true } }),
      launcher: mockLauncher([{ sessionId: "s1" }]),
      getSettings: () => defaultSettings({ sleepInhibitorEnabled: enabled }),
    });

    inhibitor.start(60_000);
    // caffeinate spawned
    expect(proc.unref).toHaveBeenCalled();

    // User disables the feature
    enabled = false;
    vi.advanceTimersByTime(60_000);
    // Should have killed caffeinate
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");

    inhibitor.stop();
  });

  // ── Multiple sessions: any generating triggers ─────────────────────

  it("triggers caffeinate if any one session out of many is generating", () => {
    setPlatform("darwin");
    spawnMock.mockReturnValue(mockProc());

    const inhibitor = new SleepInhibitor({
      wsBridge: mockWsBridge({
        s1: { isGenerating: false },
        s2: { isGenerating: false },
        s3: { isGenerating: true },
      }),
      launcher: mockLauncher([
        { sessionId: "s1" },
        { sessionId: "s2" },
        { sessionId: "s3" },
      ]),
      getSettings: () => defaultSettings({ sleepInhibitorEnabled: true }),
    });

    inhibitor.start(60_000);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    inhibitor.stop();
  });
});
