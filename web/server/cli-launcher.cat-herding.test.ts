import { vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

// ─── Hoisted mocks ──────────────────────────────────────────────────────────

// Mock randomUUID and randomBytes so session IDs and auth tokens are deterministic
vi.mock("node:crypto", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    randomUUID: () => "test-session-id",
    randomBytes: (n: number) => ({ toString: () => "a".repeat(n * 2) }),
  };
});

// Mock child_process.exec to prevent actual git commands from running in tests
const mockExec = vi.hoisted(() =>
  vi.fn((_cmd: string, _opts: any, cb: any) => {
    if (_cmd.includes("git --no-optional-locks ls-files --error-unmatch --")) {
      const err = Object.assign(new Error("Command failed: git ls-files"), {
        code: 1,
        stderr: "error: pathspec '.claude/settings.json' did not match any file(s) known to git",
      });
      if (typeof _opts === "function") {
        _opts(err, "", "");
        return;
      }
      if (cb) cb(err, "", "");
      return;
    }
    // Simulate immediate success (exec callback signature: err, stdout, stderr)
    if (typeof _opts === "function") {
      _opts(null, "", "");
      return;
    }
    if (cb) cb(null, "", "");
  }),
);
vi.mock("node:child_process", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    exec: mockExec,
  };
});

// Mock path-resolver for binary resolution
const mockResolveBinary = vi.hoisted(() => vi.fn((_name: string): string | null => "/usr/bin/claude"));
const mockGetEnrichedPath = vi.hoisted(() => vi.fn(() => "/usr/bin:/usr/local/bin"));
const mockCaptureUserShellPath = vi.hoisted(() => vi.fn(() => "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"));
const mockCaptureUserShellEnv = vi.hoisted(() => vi.fn((): Record<string, string> => ({})));
vi.mock("./path-resolver.js", () => ({
  resolveBinary: mockResolveBinary,
  getEnrichedPath: mockGetEnrichedPath,
  captureUserShellPath: mockCaptureUserShellPath,
  captureUserShellEnv: mockCaptureUserShellEnv,
}));

// Mock container-manager for container validation in relaunch
const mockIsContainerAlive = vi.hoisted(() => vi.fn((): "running" | "stopped" | "missing" => "running"));
const mockHasBinaryInContainer = vi.hoisted(() => vi.fn((): boolean => true));
const mockStartContainer = vi.hoisted(() => vi.fn());
vi.mock("./container-manager.js", () => ({
  containerManager: {
    isContainerAlive: mockIsContainerAlive,
    hasBinaryInContainer: mockHasBinaryInContainer,
    startContainer: mockStartContainer,
  },
}));

// Mock fs operations for worktree guardrails (CLAUDE.md in .claude dirs)
const mockMkdirSync = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn((..._args: any[]) => false));
const mockReadFileSync = vi.hoisted(() => vi.fn((..._args: any[]) => ""));
const mockWriteFileSync = vi.hoisted(() => vi.fn());
const mockUnlinkSync = vi.hoisted(() => vi.fn());
const mockSymlinkSync = vi.hoisted(() => vi.fn());
const mockLstatSync = vi.hoisted(() =>
  vi.fn((_path?: string): any => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }),
);
const isMockedPath = vi.hoisted(() => (path: string): boolean => {
  return (
    path.includes(".claude") ||
    path.includes(".codex") ||
    path.includes(".companion") ||
    path.startsWith("/tmp/worktrees/") ||
    path.startsWith("/tmp/main-repo")
  );
});

// Async mock functions for node:fs/promises — delegate to sync mocks so test
// setups (mockExistsSync.mockImplementation, mockReadFileSync.mockImplementation, etc.)
// and assertions (expect(mockSymlinkSync).toHaveBeenCalledWith, etc.) still work.
const mockMkdir = vi.hoisted(() =>
  vi.fn(async (...args: any[]) => {
    mockMkdirSync(...args);
  }),
);
const mockAccess = vi.hoisted(() =>
  vi.fn(async (...args: any[]) => {
    if (!mockExistsSync(args[0])) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }),
);
const mockReadFile = vi.hoisted(() => vi.fn(async (...args: any[]) => mockReadFileSync(...args)));
const mockCopyFile = vi.hoisted(() =>
  vi.fn(async (...args: any[]) => {
    // no-op for mocked paths
  }),
);
const mockCp = vi.hoisted(() =>
  vi.fn(async (..._args: any[]) => {
    // no-op for mocked paths
  }),
);
const mockReaddir = vi.hoisted(() => vi.fn(async (..._args: any[]): Promise<any[]> => []));
const mockStat = vi.hoisted(() =>
  vi.fn(async (..._args: any[]) => ({
    isFile: () => true,
    mtimeMs: 1,
  })),
);
const mockRealpath = vi.hoisted(() => vi.fn(async (...args: any[]) => args[0]));
const mockWriteFile = vi.hoisted(() =>
  vi.fn(async (...args: any[]) => {
    mockWriteFileSync(...args);
  }),
);
const mockUnlink = vi.hoisted(() =>
  vi.fn(async (...args: any[]) => {
    mockUnlinkSync(...args);
  }),
);
const mockSymlink = vi.hoisted(() =>
  vi.fn(async (...args: any[]) => {
    mockSymlinkSync(...args);
  }),
);
const mockLstat = vi.hoisted(() => vi.fn(async (...args: any[]) => mockLstatSync(...args)));

vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    mkdirSync: (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockMkdirSync(...args);
      }
      return actual.mkdirSync(...args);
    },
    existsSync: (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockExistsSync(...args);
      }
      return actual.existsSync(...args);
    },
    readFileSync: (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockReadFileSync(...args);
      }
      return actual.readFileSync(...args);
    },
    writeFileSync: (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockWriteFileSync(...args);
      }
      return actual.writeFileSync(...args);
    },
    unlinkSync: (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockUnlinkSync(...args);
      }
      return actual.unlinkSync(...args);
    },
    symlinkSync: (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockSymlinkSync(...args);
      }
      return actual.symlinkSync(...args);
    },
    lstatSync: (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockLstatSync(...args);
      }
      return actual.lstatSync(...args);
    },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    mkdir: async (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockMkdir(...args);
      }
      return actual.mkdir(...args);
    },
    access: async (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockAccess(...args);
      }
      return actual.access(...args);
    },
    readFile: async (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockReadFile(...args);
      }
      return actual.readFile(...args);
    },
    copyFile: async (...args: any[]) => {
      if (
        (typeof args[0] === "string" && isMockedPath(args[0])) ||
        (typeof args[1] === "string" && isMockedPath(args[1]))
      ) {
        return mockCopyFile(...args);
      }
      return actual.copyFile(...args);
    },
    cp: async (...args: any[]) => {
      if (
        (typeof args[0] === "string" && isMockedPath(args[0])) ||
        (typeof args[1] === "string" && isMockedPath(args[1]))
      ) {
        return mockCp(...args);
      }
      return actual.cp(...args);
    },
    readdir: async (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockReaddir(...args);
      }
      return actual.readdir(...args);
    },
    stat: async (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockStat(...args);
      }
      return actual.stat(...args);
    },
    writeFile: async (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockWriteFile(...args);
      }
      return actual.writeFile(...args);
    },
    unlink: async (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockUnlink(...args);
      }
      return actual.unlink(...args);
    },
    symlink: async (...args: any[]) => {
      // symlink(target, path) — route by target path
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockSymlink(...args);
      }
      return actual.symlink(...args);
    },
    lstat: async (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockLstat(...args);
      }
      return actual.lstat(...args);
    },
    realpath: async (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockRealpath(...args);
      }
      return actual.realpath(...args);
    },
  };
});

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import { SessionStore } from "./session-store.js";
import { CliLauncher } from "./cli-launcher.js";
import { HerdEventDispatcher } from "./herd-event-dispatcher.js";
import { createLauncherHerdChangeHandler } from "./herd-change-handler.js";
import type { TakodeEvent, TakodeHerdReassignedEventData } from "./session-types.js";

// ─── Bun.spawn mock ─────────────────────────────────────────────────────────

let exitResolve: (code: number) => void;

function createMockProc(pid = 12345) {
  let resolve: (code: number) => void;
  const exitedPromise = new Promise<number>((r) => {
    resolve = r;
  });
  exitResolve = resolve!;
  return {
    pid,
    kill: vi.fn(),
    exited: exitedPromise,
    stdout: null,
    stderr: null,
  };
}

function createMockCodexProc(pid = 12345) {
  let resolve: (code: number) => void;
  const exitedPromise = new Promise<number>((r) => {
    resolve = r;
  });
  exitResolve = resolve!;
  return {
    pid,
    kill: vi.fn(),
    exited: exitedPromise,
    stdin: new WritableStream<Uint8Array>(),
    stdout: new ReadableStream<Uint8Array>(),
    stderr: new ReadableStream<Uint8Array>(),
  };
}

const mockSpawn = vi.fn();
const bunGlobal = globalThis as typeof globalThis & { Bun?: any };
const hadBunGlobal = typeof bunGlobal.Bun !== "undefined";
const originalBunSpawn = hadBunGlobal ? bunGlobal.Bun!.spawn : undefined;
if (hadBunGlobal) {
  // In Bun runtime, globalThis.Bun is non-configurable; patch spawn directly.
  (bunGlobal.Bun as { spawn?: unknown }).spawn = mockSpawn;
} else {
  bunGlobal.Bun = { spawn: mockSpawn };
}

// ─── Test setup ──────────────────────────────────────────────────────────────

let tempDir: string;
let store: SessionStore;
let launcher: CliLauncher;

beforeEach(() => {
  vi.clearAllMocks();
  // Re-apply default: lstatSync throws ENOENT (file doesn't exist), matching real behavior
  mockLstatSync.mockImplementation(() => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });
  delete process.env.COMPANION_CONTAINER_SDK_HOST;
  delete process.env.COMPANION_FORCE_BYPASS_IN_CONTAINER;
  tempDir = mkdtempSync(join(tmpdir(), "launcher-test-"));
  store = new SessionStore(tempDir);
  launcher = new CliLauncher(3456, { serverId: "test-server-id" });
  launcher.setStore(store);
  mockSpawn.mockReturnValue(createMockProc());
  mockResolveBinary.mockReturnValue("/usr/bin/claude");
  mockGetEnrichedPath.mockReturnValue("/usr/bin:/usr/local/bin");
  mockCaptureUserShellPath.mockReturnValue("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
  mockCaptureUserShellEnv.mockReturnValue({});
  mockCopyFile.mockReset();
  mockReaddir.mockReset();
  mockStat.mockReset();
  mockReaddir.mockResolvedValue([]);
  mockStat.mockResolvedValue({
    isFile: () => true,
    mtimeMs: 1,
  });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

afterAll(() => {
  if (hadBunGlobal) {
    (bunGlobal.Bun as { spawn?: unknown }).spawn = originalBunSpawn;
  } else {
    delete bunGlobal.Bun;
  }
});

// ─── launch ──────────────────────────────────────────────────────────────────

describe("cat herding", () => {
  // Use a dedicated launcher per test to avoid leaking state via the shared
  // module-level `launcher`. Each test injects mock sessions into the store,
  // then restores them into a fresh CliLauncher instance.
  let herdLauncher: CliLauncher;

  async function setupSessions(...ids: string[]): Promise<void> {
    const sessions = ids.map((id) => ({
      sessionId: id,
      state: "connected" as const,
      cwd: "/tmp",
      createdAt: Date.now(),
      pid: 99999,
    }));
    store.saveLauncher(sessions);
    await store.flushAll(); // ensure launcher.json is written before restoreFromDisk reads it
    herdLauncher = new CliLauncher(3456, { serverId: "test-server-id" });
    herdLauncher.setStore(store);
    await herdLauncher.restoreFromDisk();
  }

  it("herds sessions and retrieves them", async () => {
    await setupSessions("orch-1", "worker-1", "worker-2");

    const result = herdLauncher.herdSessions("orch-1", ["worker-1", "worker-2"]);
    expect(result.herded).toEqual(["worker-1", "worker-2"]);
    expect(result.notFound).toEqual([]);

    const herded = herdLauncher.getHerdedSessions("orch-1");
    expect(herded.map((s) => s.sessionId).sort()).toEqual(["worker-1", "worker-2"]);
  });

  it("herding is idempotent — re-herding same orchestrator is a no-op", async () => {
    await setupSessions("orch-1", "worker-1");

    herdLauncher.herdSessions("orch-1", ["worker-1"]);
    herdLauncher.herdSessions("orch-1", ["worker-1"]); // idempotent

    const worker = herdLauncher.getSession("worker-1");
    expect(worker?.herdedBy).toBe("orch-1");
  });

  it("rejects herding by a second leader (conflict)", async () => {
    // Conflicting herd attempts must preserve the original ownership path and
    // must not emit reassignment side effects when force was not requested.
    await setupSessions("orch-1", "orch-2", "worker-1");

    const herdChange = vi.fn();
    herdLauncher.onHerdChange = herdChange;
    herdLauncher.herdSessions("orch-1", ["worker-1"]);
    const result = herdLauncher.herdSessions("orch-2", ["worker-1"]);

    // worker-1 stays with orch-1, orch-2 gets a conflict
    expect(result.herded).toEqual([]);
    expect(result.conflicts).toEqual([{ id: "worker-1", herder: "orch-1" }]);

    const worker = herdLauncher.getSession("worker-1");
    expect(worker?.herdedBy).toBe("orch-1"); // unchanged
    expect(herdChange).not.toHaveBeenCalledWith(expect.objectContaining({ type: "reassigned", workerId: "worker-1" }));
  });

  it("force-reassigns a worker to a new leader and notifies before herd membership changes", async () => {
    // Force takeover must emit the reassignment event before membership refresh
    // so downstream consumers can notify the old leader on the pre-mutation path.
    await setupSessions("orch-1", "orch-2", "worker-1", "reviewer-1");

    const worker = herdLauncher.getSession("worker-1");
    const reviewer = herdLauncher.getSession("reviewer-1");
    expect(worker).toBeDefined();
    expect(reviewer).toBeDefined();
    worker!.sessionNum = 42;
    worker!.herdedBy = "orch-1";
    reviewer!.reviewerOf = 42;
    reviewer!.herdedBy = "orch-1";

    const herdChange = vi.fn();
    herdLauncher.onHerdChange = herdChange;

    const result = herdLauncher.herdSessions("orch-2", ["worker-1"], { force: true });

    expect(result.herded).toEqual(["worker-1"]);
    expect(result.conflicts).toEqual([]);
    expect(result.reassigned).toEqual([{ id: "worker-1", fromLeader: "orch-1" }]);
    expect(herdChange).toHaveBeenCalledWith({
      type: "reassigned",
      workerId: "worker-1",
      fromLeaderId: "orch-1",
      toLeaderId: "orch-2",
      reviewerCount: 1,
    });
    const reassignedCallOrder = herdChange.mock.invocationCallOrder[0];
    const membershipCallOrder = herdChange.mock.invocationCallOrder.find((_, idx) => {
      return herdChange.mock.calls[idx][0]?.type === "membership_changed";
    });
    expect(reassignedCallOrder).toBeLessThan(membershipCallOrder ?? Number.POSITIVE_INFINITY);
    expect(herdLauncher.getSession("worker-1")?.herdedBy).toBe("orch-2");
    expect(herdLauncher.getSession("reviewer-1")?.herdedBy).toBe("orch-2");
  });

  it("preserves the old leader inbox long enough to deliver herd_reassigned on the real bootstrap path", async () => {
    // End-to-end regression: when the moved worker was the old leader's last
    // herd member, the production launcher->bridge->dispatcher wiring must still
    // deliver herd_reassigned before the zero-worker inbox is retired.
    vi.useFakeTimers();
    try {
      await setupSessions("orch-1", "orch-2", "worker-1");

      const subscriptions = new Set<{ sessions: Set<string>; cb: (evt: TakodeEvent) => void }>();
      const bridge = {
        subscribeTakodeEvents: vi.fn((sessions: Set<string>, cb: (evt: TakodeEvent) => void) => {
          const sub = { sessions: new Set(sessions), cb };
          subscriptions.add(sub);
          return () => {
            subscriptions.delete(sub);
          };
        }),
        injectUserMessage: vi.fn(() => "sent" as const),
        isSessionIdle: vi.fn(() => true),
        wakeIdleKilledSession: vi.fn(() => false),
        getSession: vi.fn(() => undefined),
      };
      const emitTakodeEvent = (event: TakodeEvent) => {
        for (const sub of subscriptions) {
          if (sub.sessions.has(event.sessionId)) sub.cb(event);
        }
      };

      const dispatcher = new HerdEventDispatcher(bridge, herdLauncher);
      const emitBridgeEvent = vi.fn(
        (sessionId: string, event: "herd_reassigned", data: TakodeHerdReassignedEventData, actorSessionId?: string) => {
          emitTakodeEvent({
            id: Date.now(),
            event,
            sessionId,
            sessionNum: herdLauncher.getSessionNum(sessionId) ?? -1,
            sessionName: herdLauncher.getSession(sessionId)?.name || sessionId,
            ts: Date.now(),
            ...(actorSessionId ? { actorSessionId } : {}),
            data,
          } as TakodeEvent);
        },
      );
      herdLauncher.onHerdChange = createLauncherHerdChangeHandler({
        dispatcher,
        wsBridge: {
          emitTakodeEvent: emitBridgeEvent,
        },
        launcher: herdLauncher,
        getSessionName: () => undefined,
      });

      herdLauncher.herdSessions("orch-1", ["worker-1"]);
      dispatcher.setupForOrchestrator("orch-1");

      herdLauncher.herdSessions("orch-2", ["worker-1"], { force: true });
      expect(emitBridgeEvent).toHaveBeenCalledWith(
        "worker-1",
        "herd_reassigned",
        expect.objectContaining({
          fromLeaderSessionId: "orch-1",
          toLeaderSessionId: "orch-2",
        }),
        "orch-2",
      );

      vi.advanceTimersByTime(600);

      expect(bridge.injectUserMessage).toHaveBeenCalledWith(
        "orch-1",
        expect.stringContaining("herd_reassigned"),
        {
          sessionId: "herd-events",
          sessionLabel: "Herd Events",
        },
        undefined,
        { threadKey: "main" },
      );

      dispatcher.onOrchestratorTurnEnd("orch-1");
      expect(dispatcher._getInbox("orch-1")).toBeUndefined();
      dispatcher.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("transfers attached reviewers with the worker herd", async () => {
    // When a worker moves between leaders, active reviewer sessions must follow
    // the worker so the new leader retains operational access.
    await setupSessions("orch-1", "orch-2", "worker-1", "reviewer-1");

    const worker = herdLauncher.getSession("worker-1");
    const reviewer = herdLauncher.getSession("reviewer-1");
    expect(worker).toBeDefined();
    expect(reviewer).toBeDefined();
    worker!.sessionNum = 42;
    // Simulate the real stale state from q-273: the worker is currently
    // unherded, but its attached reviewer still belongs to the old leader.
    reviewer!.reviewerOf = 42;
    reviewer!.herdedBy = "orch-1";

    const herdChange = vi.fn();
    herdLauncher.onHerdChange = herdChange;

    const result = herdLauncher.herdSessions("orch-2", ["worker-1"]);

    expect(result.herded).toEqual(["worker-1"]);
    expect(result.conflicts).toEqual([]);
    expect(herdLauncher.getSession("worker-1")?.herdedBy).toBe("orch-2");
    expect(herdLauncher.getSession("reviewer-1")).toMatchObject({
      reviewerOf: 42,
      herdedBy: "orch-2",
    });
    expect(
      herdLauncher
        .getHerdedSessions("orch-2")
        .map((s) => s.sessionId)
        .sort(),
    ).toEqual(["reviewer-1", "worker-1"]);
    expect(herdLauncher.getHerdedSessions("orch-1")).toEqual([]);
    expect(herdChange).toHaveBeenCalledWith({ type: "membership_changed", leaderId: "orch-2" });
    expect(herdChange).toHaveBeenCalledWith({ type: "membership_changed", leaderId: "orch-1" });
  });

  it("ignores archived reviewers when transferring a worker herd", async () => {
    // Archived reviewers are historical records; moving the worker must not
    // resurrect or reassign them to a new leader.
    await setupSessions("orch-1", "worker-1", "reviewer-1");

    const worker = herdLauncher.getSession("worker-1");
    const reviewer = herdLauncher.getSession("reviewer-1");
    expect(worker).toBeDefined();
    expect(reviewer).toBeDefined();
    worker!.sessionNum = 42;
    const herdChange = vi.fn();
    herdLauncher.onHerdChange = herdChange;
    // Archived reviewers should remain historical records; transferring the
    // worker must not reassign them or refresh the previous leader for them.
    reviewer!.reviewerOf = 42;
    reviewer!.herdedBy = "orch-2";
    reviewer!.archived = true;

    herdLauncher.herdSessions("orch-1", ["worker-1"]);

    expect(herdLauncher.getSession("worker-1")?.herdedBy).toBe("orch-1");
    expect(herdLauncher.getSession("reviewer-1")).toMatchObject({
      reviewerOf: 42,
      herdedBy: "orch-2",
      archived: true,
    });
    expect(herdLauncher.getHerdedSessions("orch-1").map((s) => s.sessionId)).toEqual(["worker-1"]);
    expect(herdChange).toHaveBeenCalledWith({ type: "membership_changed", leaderId: "orch-1" });
    expect(herdChange).not.toHaveBeenCalledWith({ type: "membership_changed", leaderId: "orch-2" });
  });

  it("does not transfer attached reviewers on conflicting herd attempts", async () => {
    // A non-force conflict must leave both the worker and attached reviewers
    // with the original leader.
    await setupSessions("orch-1", "orch-2", "worker-1", "reviewer-1");

    const worker = herdLauncher.getSession("worker-1");
    const reviewer = herdLauncher.getSession("reviewer-1");
    expect(worker).toBeDefined();
    expect(reviewer).toBeDefined();
    worker!.sessionNum = 42;
    worker!.herdedBy = "orch-1";
    reviewer!.reviewerOf = 42;
    reviewer!.herdedBy = "orch-1";

    const result = herdLauncher.herdSessions("orch-2", ["worker-1"]);

    expect(result.herded).toEqual([]);
    expect(result.conflicts).toEqual([{ id: "worker-1", herder: "orch-1" }]);
    expect(herdLauncher.getSession("worker-1")?.herdedBy).toBe("orch-1");
    expect(herdLauncher.getSession("reviewer-1")).toMatchObject({
      reviewerOf: 42,
      herdedBy: "orch-1",
    });
  });

  it("unherds a session", async () => {
    await setupSessions("orch-1", "worker-1", "reviewer-1");

    const worker = herdLauncher.getSession("worker-1");
    const reviewer = herdLauncher.getSession("reviewer-1");
    expect(worker).toBeDefined();
    expect(reviewer).toBeDefined();
    worker!.sessionNum = 42;
    reviewer!.reviewerOf = 42;

    // Unherding the worker should also clear any active attached reviewer so
    // send/reuse authorization cannot linger on an orphaned reviewer session.
    herdLauncher.herdSessions("orch-1", ["worker-1"]);
    expect(herdLauncher.unherdSession("orch-1", "worker-1")).toBe(true);

    expect(herdLauncher.getSession("worker-1")?.herdedBy).toBeUndefined(); // cleaned up when empty
    expect(herdLauncher.getSession("reviewer-1")?.herdedBy).toBeUndefined();
    expect(herdLauncher.getHerdedSessions("orch-1")).toEqual([]);
  });

  it("unherd returns false for non-herded session", async () => {
    await setupSessions("orch-1", "worker-1");
    expect(herdLauncher.unherdSession("orch-1", "worker-1")).toBe(false);
  });

  it("unherd returns false when herded by a different leader", async () => {
    await setupSessions("orch-1", "orch-2", "worker-1");

    herdLauncher.herdSessions("orch-1", ["worker-1"]);
    // orch-2 can't unherd orch-1's worker
    expect(herdLauncher.unherdSession("orch-2", "worker-1")).toBe(false);

    const worker = herdLauncher.getSession("worker-1");
    expect(worker?.herdedBy).toBe("orch-1"); // unchanged
  });

  it("reports not-found worker IDs", async () => {
    await setupSessions("orch-1");

    const result = herdLauncher.herdSessions("orch-1", ["nonexistent-uuid"]);
    expect(result.herded).toEqual([]);
    expect(result.notFound).toEqual(["nonexistent-uuid"]);
  });

  it("getHerdedSessions returns empty for non-herding orchestrator", async () => {
    await setupSessions("orch-1");
    expect(herdLauncher.getHerdedSessions("orch-1")).toEqual([]);
  });

  it("getHerdedSessions excludes archived workers", async () => {
    // Archived workers must not appear as live herd members (q-605)
    await setupSessions("orch-1", "worker-1", "worker-2");
    herdLauncher.herdSessions("orch-1", ["worker-1", "worker-2"]);

    herdLauncher.setArchived("worker-1", true);

    const herded = herdLauncher.getHerdedSessions("orch-1");
    expect(herded.map((s) => s.sessionId)).toEqual(["worker-2"]);
  });

  it("setArchived on a worker clears herdedBy and fires onHerdChange", async () => {
    // Archiving a worker must sever its herd link so the leader's herd
    // doesn't include stale members after restart (q-605)
    await setupSessions("orch-1", "worker-1");
    herdLauncher.herdSessions("orch-1", ["worker-1"]);

    const herdChange = vi.fn();
    herdLauncher.onHerdChange = herdChange;

    herdLauncher.setArchived("worker-1", true);

    const worker = herdLauncher.getSession("worker-1");
    expect(worker?.herdedBy).toBeUndefined();
    expect(herdChange).toHaveBeenCalledWith({ type: "membership_changed", leaderId: "orch-1" });
  });

  it("setArchived on a worker also detaches its attached reviewer from the herd", async () => {
    // Mirrors unherdSession's reviewer cleanup: archiving a herded worker
    // must also clear herdedBy on any reviewer attached via reviewerOf.
    await setupSessions("orch-1", "worker-1", "reviewer-1");
    const worker = herdLauncher.getSession("worker-1")!;
    const reviewer = herdLauncher.getSession("reviewer-1")!;
    worker.sessionNum = 42;
    herdLauncher.herdSessions("orch-1", ["worker-1"]);
    reviewer.reviewerOf = 42;
    reviewer.herdedBy = "orch-1";

    herdLauncher.setArchived("worker-1", true);

    expect(reviewer.herdedBy).toBeUndefined();
    expect(herdLauncher.getHerdedSessions("orch-1")).toEqual([]);
  });

  it("archived orchestrator is ineligible for herd bootstrap after restart", async () => {
    // Simulates stale persisted state: an archived orchestrator whose worker
    // still has herdedBy set (e.g. server crashed before cleanup completed).
    // The !s.archived guard in the bootstrap loop (index.ts:189-192) must be
    // the deciding factor, not herd cleanup side effects.
    await setupSessions("orch-1", "worker-1");
    const orchInfo = herdLauncher.getSession("orch-1")!;
    orchInfo.isOrchestrator = true;
    herdLauncher.herdSessions("orch-1", ["worker-1"]);

    // Directly set archived without calling setArchived() to preserve the
    // stale herdedBy on worker-1 (simulates crash-before-cleanup scenario)
    orchInfo.archived = true;

    const worker = herdLauncher.getSession("worker-1")!;
    expect(worker.herdedBy).toBe("orch-1"); // stale link still present

    // With archived=true, bootstrap must skip despite live herded workers
    const bootstrapCondition = (s: { isOrchestrator?: boolean; archived?: boolean; sessionId: string }) =>
      s.isOrchestrator === true && !s.archived && herdLauncher.getHerdedSessions(s.sessionId).length > 0;

    expect(bootstrapCondition(orchInfo)).toBe(false);

    // Control: same orchestrator un-archived would pass the bootstrap
    orchInfo.archived = false;
    expect(bootstrapCondition(orchInfo)).toBe(true);
  });
});
