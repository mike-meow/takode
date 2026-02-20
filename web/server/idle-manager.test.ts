import { describe, it, expect, vi, beforeEach } from "vitest";
import { IdleManager } from "./idle-manager.js";
import type { CliLauncher } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";
import type { SdkSessionInfo } from "./cli-launcher.js";

function makeSession(
  id: string,
  overrides: Partial<SdkSessionInfo> = {},
): SdkSessionInfo {
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
    kill: vi.fn(),
  } as unknown as CliLauncher;

  const wsBridge = {
    isSessionBusy: vi.fn((id: string) => busyIds.has(id)),
  } as unknown as WsBridge;

  const getSettings = () => ({ maxKeepAlive });

  return { launcher, wsBridge, getSettings };
}

describe("IdleManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing when maxKeepAlive is 0 (disabled)", () => {
    const sessions = [makeSession("s1"), makeSession("s2"), makeSession("s3"), makeSession("s4")];
    const { launcher, wsBridge, getSettings } = createMocks(sessions, new Set(), 0);
    const mgr = new IdleManager(launcher, wsBridge, getSettings);

    const killed = mgr.sweep();
    expect(killed).toBe(0);
    expect(launcher.kill).not.toHaveBeenCalled();
  });

  it("does nothing when alive count is within limit", () => {
    const sessions = [makeSession("s1"), makeSession("s2")];
    const { launcher, wsBridge, getSettings } = createMocks(sessions, new Set(), 3);
    const mgr = new IdleManager(launcher, wsBridge, getSettings);

    const killed = mgr.sweep();
    expect(killed).toBe(0);
    expect(launcher.kill).not.toHaveBeenCalled();
  });

  it("kills oldest idle sessions when exceeding maxKeepAlive", () => {
    const now = Date.now();
    const sessions = [
      makeSession("s1", { lastActivityAt: now - 3000 }), // oldest
      makeSession("s2", { lastActivityAt: now - 2000 }),
      makeSession("s3", { lastActivityAt: now - 1000 }), // most recent
    ];
    const { launcher, wsBridge, getSettings } = createMocks(sessions, new Set(), 2);
    const mgr = new IdleManager(launcher, wsBridge, getSettings);

    const killed = mgr.sweep();
    expect(killed).toBe(1);
    expect(launcher.kill).toHaveBeenCalledWith("s1"); // oldest killed
    expect(launcher.kill).not.toHaveBeenCalledWith("s3"); // most recent kept
  });

  it("never kills busy sessions", () => {
    const now = Date.now();
    const sessions = [
      makeSession("s1", { lastActivityAt: now - 3000 }), // oldest, but busy
      makeSession("s2", { lastActivityAt: now - 2000 }),
      makeSession("s3", { lastActivityAt: now - 1000 }),
    ];
    // s1 is busy — should be skipped
    const { launcher, wsBridge, getSettings } = createMocks(sessions, new Set(["s1"]), 2);
    const mgr = new IdleManager(launcher, wsBridge, getSettings);

    const killed = mgr.sweep();
    // s1 is busy so can't be killed; s2 is next oldest
    expect(killed).toBe(1);
    expect(launcher.kill).toHaveBeenCalledWith("s2");
    expect(launcher.kill).not.toHaveBeenCalledWith("s1");
  });

  it("skips exited sessions when counting alive", () => {
    const sessions = [
      makeSession("s1", { state: "exited" }),
      makeSession("s2"),
      makeSession("s3"),
    ];
    // Only s2 and s3 are alive — within limit of 2
    const { launcher, wsBridge, getSettings } = createMocks(sessions, new Set(), 2);
    const mgr = new IdleManager(launcher, wsBridge, getSettings);

    const killed = mgr.sweep();
    expect(killed).toBe(0);
  });

  it("skips archived sessions when counting alive", () => {
    const sessions = [
      makeSession("s1", { archived: true }),
      makeSession("s2"),
      makeSession("s3"),
    ];
    const { launcher, wsBridge, getSettings } = createMocks(sessions, new Set(), 2);
    const mgr = new IdleManager(launcher, wsBridge, getSettings);

    const killed = mgr.sweep();
    expect(killed).toBe(0);
  });

  it("falls back to createdAt when lastActivityAt is missing", () => {
    const now = Date.now();
    const sessions = [
      makeSession("s1", { lastActivityAt: undefined, createdAt: now - 5000 }), // oldest by createdAt
      makeSession("s2", { lastActivityAt: now - 1000 }),
      makeSession("s3", { lastActivityAt: now }),
    ];
    const { launcher, wsBridge, getSettings } = createMocks(sessions, new Set(), 2);
    const mgr = new IdleManager(launcher, wsBridge, getSettings);

    const killed = mgr.sweep();
    expect(killed).toBe(1);
    expect(launcher.kill).toHaveBeenCalledWith("s1");
  });

  it("kills multiple sessions if needed to meet the limit", () => {
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

    const killed = mgr.sweep();
    expect(killed).toBe(3);
    expect(launcher.kill).toHaveBeenCalledWith("s1");
    expect(launcher.kill).toHaveBeenCalledWith("s2");
    expect(launcher.kill).toHaveBeenCalledWith("s3");
    expect(launcher.kill).not.toHaveBeenCalledWith("s4");
    expect(launcher.kill).not.toHaveBeenCalledWith("s5");
  });

  it("cannot kill enough if too many are busy — kills what it can", () => {
    const now = Date.now();
    const sessions = [
      makeSession("s1", { lastActivityAt: now - 3000 }), // busy
      makeSession("s2", { lastActivityAt: now - 2000 }), // busy
      makeSession("s3", { lastActivityAt: now - 1000 }), // killable
    ];
    // Need to kill 1 to reach limit of 2, but s1 and s2 are busy — s3 is newest but killable
    const { launcher, wsBridge, getSettings } = createMocks(sessions, new Set(["s1", "s2"]), 2);
    const mgr = new IdleManager(launcher, wsBridge, getSettings);

    const killed = mgr.sweep();
    expect(killed).toBe(1);
    expect(launcher.kill).toHaveBeenCalledWith("s3");
  });

  it("start/stop controls the interval timer", () => {
    vi.useFakeTimers();
    const sessions = [
      makeSession("s1"),
      makeSession("s2"),
      makeSession("s3"),
      makeSession("s4"),
    ];
    const { launcher, wsBridge, getSettings } = createMocks(sessions, new Set(), 2);
    const mgr = new IdleManager(launcher, wsBridge, getSettings);

    mgr.start(1000);
    expect(launcher.kill).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(launcher.kill).toHaveBeenCalled();

    mgr.stop();
    vi.clearAllMocks();
    vi.advanceTimersByTime(2000);
    expect(launcher.kill).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});
