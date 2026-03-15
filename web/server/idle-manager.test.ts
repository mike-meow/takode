import { describe, it, expect, vi, beforeEach } from "vitest";
import { IdleManager } from "./idle-manager.js";
import type { CliLauncher } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";
import type { SdkSessionInfo } from "./cli-launcher.js";

function makeSession(id: string, overrides: Partial<SdkSessionInfo> = {}): SdkSessionInfo {
  return {
    sessionId: id,
    state: "running",
    cwd: "/tmp",
    createdAt: Date.now() - 60_000,
    lastActivityAt: Date.now() - 60_000,
    ...overrides,
  };
}

function createMocks(sessions: SdkSessionInfo[], busyIds: Set<string> = new Set(), maxKeepAlive = 3) {
  const launcher = {
    listSessions: vi.fn(() => sessions),
    kill: vi.fn().mockResolvedValue(true),
  } as unknown as CliLauncher;

  const wsBridge = {
    isSessionBusy: vi.fn((id: string) => busyIds.has(id)),
    killSession: vi.fn().mockResolvedValue(true),
  } as unknown as WsBridge;

  const getSettings = () => ({ maxKeepAlive });

  return { launcher, wsBridge, getSettings };
}

describe("IdleManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing when maxKeepAlive is 0 (disabled)", async () => {
    const sessions = [makeSession("s1"), makeSession("s2"), makeSession("s3"), makeSession("s4")];
    const { launcher, wsBridge, getSettings } = createMocks(sessions, new Set(), 0);
    const mgr = new IdleManager(launcher, wsBridge, getSettings);

    const killed = await mgr.sweep();
    expect(killed).toBe(0);
    expect(wsBridge.killSession).not.toHaveBeenCalled();
  });

  it("does nothing when alive count is within limit", async () => {
    const sessions = [makeSession("s1"), makeSession("s2")];
    const { launcher, wsBridge, getSettings } = createMocks(sessions, new Set(), 3);
    const mgr = new IdleManager(launcher, wsBridge, getSettings);

    const killed = await mgr.sweep();
    expect(killed).toBe(0);
    expect(wsBridge.killSession).not.toHaveBeenCalled();
  });

  it("kills oldest idle sessions when exceeding maxKeepAlive", async () => {
    const now = Date.now();
    const sessions = [
      makeSession("s1", { lastActivityAt: now - 3000 }), // oldest
      makeSession("s2", { lastActivityAt: now - 2000 }),
      makeSession("s3", { lastActivityAt: now - 1000 }), // most recent
    ];
    const { launcher, wsBridge, getSettings } = createMocks(sessions, new Set(), 2);
    const mgr = new IdleManager(launcher, wsBridge, getSettings);

    const killed = await mgr.sweep();
    expect(killed).toBe(1);
    expect(wsBridge.killSession).toHaveBeenCalledWith("s1"); // oldest killed
    expect(wsBridge.killSession).not.toHaveBeenCalledWith("s3"); // most recent kept
  });

  it("never kills busy sessions", async () => {
    const now = Date.now();
    const sessions = [
      makeSession("s1", { lastActivityAt: now - 3000 }), // oldest, but busy
      makeSession("s2", { lastActivityAt: now - 2000 }),
      makeSession("s3", { lastActivityAt: now - 1000 }),
    ];
    // s1 is busy — should be skipped
    const { launcher, wsBridge, getSettings } = createMocks(sessions, new Set(["s1"]), 2);
    const mgr = new IdleManager(launcher, wsBridge, getSettings);

    const killed = await mgr.sweep();
    // s1 is busy so can't be killed; s2 is next oldest
    expect(killed).toBe(1);
    expect(wsBridge.killSession).toHaveBeenCalledWith("s2");
    expect(wsBridge.killSession).not.toHaveBeenCalledWith("s1");
  });

  it("skips exited sessions when counting alive", async () => {
    const sessions = [makeSession("s1", { state: "exited" }), makeSession("s2"), makeSession("s3")];
    // Only s2 and s3 are alive — within limit of 2
    const { launcher, wsBridge, getSettings } = createMocks(sessions, new Set(), 2);
    const mgr = new IdleManager(launcher, wsBridge, getSettings);

    const killed = await mgr.sweep();
    expect(killed).toBe(0);
  });

  it("skips archived sessions when counting alive", async () => {
    const sessions = [makeSession("s1", { archived: true }), makeSession("s2"), makeSession("s3")];
    const { launcher, wsBridge, getSettings } = createMocks(sessions, new Set(), 2);
    const mgr = new IdleManager(launcher, wsBridge, getSettings);

    const killed = await mgr.sweep();
    expect(killed).toBe(0);
  });

  it("falls back to createdAt when lastActivityAt is missing", async () => {
    const now = Date.now();
    const sessions = [
      makeSession("s1", { lastActivityAt: undefined, createdAt: now - 5000 }), // oldest by createdAt
      makeSession("s2", { lastActivityAt: now - 1000 }),
      makeSession("s3", { lastActivityAt: now }),
    ];
    const { launcher, wsBridge, getSettings } = createMocks(sessions, new Set(), 2);
    const mgr = new IdleManager(launcher, wsBridge, getSettings);

    const killed = await mgr.sweep();
    expect(killed).toBe(1);
    expect(wsBridge.killSession).toHaveBeenCalledWith("s1");
  });

  it("kills multiple sessions if needed to meet the limit", async () => {
    const now = Date.now();
    const sessions = [
      makeSession("s1", { lastActivityAt: now - 4000 }),
      makeSession("s2", { lastActivityAt: now - 3000 }),
      makeSession("s3", { lastActivityAt: now - 2000 }),
      makeSession("s4", { lastActivityAt: now - 1000 }),
      makeSession("s5", { lastActivityAt: now }),
    ];
    const { launcher, wsBridge, getSettings } = createMocks(sessions, new Set(), 2);
    const mgr = new IdleManager(launcher, wsBridge, getSettings);

    const killed = await mgr.sweep();
    expect(killed).toBe(3);
    expect(wsBridge.killSession).toHaveBeenCalledWith("s1");
    expect(wsBridge.killSession).toHaveBeenCalledWith("s2");
    expect(wsBridge.killSession).toHaveBeenCalledWith("s3");
    expect(wsBridge.killSession).not.toHaveBeenCalledWith("s4");
    expect(wsBridge.killSession).not.toHaveBeenCalledWith("s5");
  });

  it("cannot kill enough if too many are busy — kills what it can", async () => {
    const now = Date.now();
    const sessions = [
      makeSession("s1", { lastActivityAt: now - 3000 }), // busy
      makeSession("s2", { lastActivityAt: now - 2000 }), // busy
      makeSession("s3", { lastActivityAt: now - 1000 }), // killable
    ];
    // Need to kill 1 to reach limit of 2, but s1 and s2 are busy — s3 is newest but killable
    const { launcher, wsBridge, getSettings } = createMocks(sessions, new Set(["s1", "s2"]), 2);
    const mgr = new IdleManager(launcher, wsBridge, getSettings);

    const killed = await mgr.sweep();
    expect(killed).toBe(1);
    expect(wsBridge.killSession).toHaveBeenCalledWith("s3");
  });

  it("sets killedByIdleManager flag on sessions before killing", async () => {
    // The idle manager should mark sessions with killedByIdleManager=true before
    // calling killSession(), so ws-bridge can broadcast the reason to browsers.
    const now = Date.now();
    const sessions = [
      makeSession("s1", { lastActivityAt: now - 3000 }),
      makeSession("s2", { lastActivityAt: now - 2000 }),
      makeSession("s3", { lastActivityAt: now - 1000 }),
    ];
    const { launcher, wsBridge, getSettings } = createMocks(sessions, new Set(), 2);
    const mgr = new IdleManager(launcher, wsBridge, getSettings);

    await mgr.sweep();
    // s1 is the oldest and should be killed — verify flag was set
    expect(sessions[0].killedByIdleManager).toBe(true);
    // s2 and s3 should NOT have the flag
    expect(sessions[1].killedByIdleManager).toBeUndefined();
    expect(sessions[2].killedByIdleManager).toBeUndefined();
  });

  it("only counts successful kills (failed kills are not counted)", async () => {
    // Regression: the old idle manager counted kills unconditionally, so a
    // failed kill (e.g., SDK session with no subprocess) would still be
    // "counted" but the session would stay alive — causing an infinite loop.
    const now = Date.now();
    const sessions = [
      makeSession("s1", { lastActivityAt: now - 3000 }),
      makeSession("s2", { lastActivityAt: now - 2000 }),
      makeSession("s3", { lastActivityAt: now - 1000 }),
    ];
    const { launcher, wsBridge, getSettings } = createMocks(sessions, new Set(), 2);
    // killSession returns false for s1 (simulating SDK session kill failure)
    (wsBridge.killSession as ReturnType<typeof vi.fn>).mockImplementation((id: string) => Promise.resolve(id !== "s1"));
    const mgr = new IdleManager(launcher, wsBridge, getSettings);

    const killed = await mgr.sweep();
    // s1 failed to kill, s2 succeeded — only 1 actual kill
    // (the idle manager tried both since toKill=1 but s1 failed)
    // Actually toKill = 3-2 = 1, so it only tries s1 (oldest), which fails
    expect(killed).toBe(0);
    expect(wsBridge.killSession).toHaveBeenCalledWith("s1");
    expect(wsBridge.killSession).toHaveBeenCalledTimes(1);
  });

  it("start/stop controls the interval timer", () => {
    vi.useFakeTimers();
    const sessions = [makeSession("s1"), makeSession("s2"), makeSession("s3"), makeSession("s4")];
    const { launcher, wsBridge, getSettings } = createMocks(sessions, new Set(), 2);
    const mgr = new IdleManager(launcher, wsBridge, getSettings);

    mgr.start(1000);
    expect(wsBridge.killSession).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    // sweep is async but fire-and-forget from the interval
    expect(wsBridge.killSession).toHaveBeenCalled();

    mgr.stop();
    vi.clearAllMocks();
    vi.advanceTimersByTime(2000);
    expect(wsBridge.killSession).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});
