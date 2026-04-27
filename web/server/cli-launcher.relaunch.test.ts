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

describe("relaunch", () => {
  it("kills old process and spawns new one with --resume", async () => {
    // Create first proc whose exit resolves immediately when killed
    let resolveFirst: (code: number) => void;
    const firstProc = {
      pid: 12345,
      kill: vi.fn(() => {
        resolveFirst(0);
      }),
      exited: new Promise<number>((r) => {
        resolveFirst = r;
      }),
      stdout: null,
      stderr: null,
    };
    mockSpawn.mockReturnValueOnce(firstProc);

    await launcher.launch({ cwd: "/tmp/project", model: "claude-sonnet-4-5-20250929" });
    launcher.setCLISessionId("test-session-id", "cli-resume-id");

    // Second proc for the relaunch — never exits during test
    const secondProc = createMockProc(54321);
    mockSpawn.mockReturnValueOnce(secondProc);

    const result = await launcher.relaunch("test-session-id");
    expect(result).toEqual({ ok: true });

    // Old process should have been killed
    expect(firstProc.kill).toHaveBeenCalledWith("SIGTERM");

    // New process should be spawned with --resume
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    const [cmdAndArgs] = mockSpawn.mock.calls[1];
    expect(cmdAndArgs).toContain("--resume");
    expect(cmdAndArgs).toContain("cli-resume-id");

    // Session state should be reset to starting (set by relaunch before spawnCLI)
    // Allow microtask queue to flush
    await new Promise((r) => setTimeout(r, 10));
    const session = launcher.getSession("test-session-id");
    expect(session?.state).toBe("starting");
  });

  it("reuses launch env variables during relaunch", async () => {
    let resolveFirst: (code: number) => void;
    const firstProc = {
      pid: 12345,
      kill: vi.fn(() => {
        resolveFirst(0);
      }),
      exited: new Promise<number>((r) => {
        resolveFirst = r;
      }),
      stdout: null,
      stderr: null,
    };
    mockSpawn.mockReturnValueOnce(firstProc);

    await launcher.launch({
      cwd: "/tmp/project",
      containerId: "abc123def456",
      containerName: "companion-test",
      env: { CLAUDE_CODE_OAUTH_TOKEN: "tok-test" },
    });

    const secondProc = createMockProc(54321);
    mockSpawn.mockReturnValueOnce(secondProc);

    const result = await launcher.relaunch("test-session-id");
    expect(result).toEqual({ ok: true });

    const [relaunchCmd] = mockSpawn.mock.calls[1];
    expect(relaunchCmd).toContain("-e");
    expect(relaunchCmd).toContain("CLAUDE_CODE_OAUTH_TOKEN=tok-test");
    expect(relaunchCmd.some((arg: string) => arg.startsWith("COMPANION_SERVER_ID=test-server-id"))).toBe(true);
    expect(relaunchCmd.some((arg: string) => arg.startsWith("COMPANION_AUTH_TOKEN="))).toBe(true);
  });

  it("returns error for unknown session", async () => {
    const result = await launcher.relaunch("nonexistent");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Session not found");
  });

  it("returns error when container was removed externally", async () => {
    // Launch a containerized session
    await launcher.launch({
      cwd: "/tmp/project",
      containerId: "abc123def456",
      containerName: "companion-gone",
    });

    // Simulate container being removed
    mockIsContainerAlive.mockReturnValueOnce("missing");

    const result = await launcher.relaunch("test-session-id");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("companion-gone");
    expect(result.error).toContain("removed externally");

    // Session should be marked as exited
    const session = launcher.getSession("test-session-id");
    expect(session?.state).toBe("exited");
    expect(session?.exitCode).toBe(1);

    // Should NOT have spawned a new process
    expect(mockSpawn).toHaveBeenCalledTimes(1); // only the initial launch
  });

  it("restarts stopped container before spawning CLI", async () => {
    // Create initial proc that exits immediately when killed
    let resolveFirst: (code: number) => void;
    const firstProc = {
      pid: 12345,
      kill: vi.fn(() => {
        resolveFirst(0);
      }),
      exited: new Promise<number>((r) => {
        resolveFirst = r;
      }),
      stdout: null,
      stderr: null,
    };
    mockSpawn.mockReturnValueOnce(firstProc);

    await launcher.launch({
      cwd: "/tmp/project",
      containerId: "abc123def456",
      containerName: "companion-stopped",
    });

    // Container is stopped but can be restarted
    mockIsContainerAlive.mockReturnValueOnce("stopped");
    mockHasBinaryInContainer.mockReturnValueOnce(true);

    const secondProc = createMockProc(54321);
    mockSpawn.mockReturnValueOnce(secondProc);

    const result = await launcher.relaunch("test-session-id");
    expect(result).toEqual({ ok: true });
    expect(mockStartContainer).toHaveBeenCalledWith("abc123def456");
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it("returns error when stopped container cannot be restarted", async () => {
    await launcher.launch({
      cwd: "/tmp/project",
      containerId: "abc123def456",
      containerName: "companion-dead",
    });

    mockIsContainerAlive.mockReturnValueOnce("stopped");
    mockStartContainer.mockImplementationOnce(() => {
      throw new Error("container start failed");
    });

    const result = await launcher.relaunch("test-session-id");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("companion-dead");
    expect(result.error).toContain("stopped");
    expect(result.error).toContain("container start failed");
  });

  it("returns error when CLI binary not found in container", async () => {
    await launcher.launch({
      cwd: "/tmp/project",
      containerId: "abc123def456",
      containerName: "companion-nobin",
    });

    mockIsContainerAlive.mockReturnValueOnce("running");
    mockHasBinaryInContainer.mockReturnValueOnce(false);

    const result = await launcher.relaunch("test-session-id");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("claude");
    expect(result.error).toContain("not found");
    expect(result.error).toContain("companion-nobin");

    const session = launcher.getSession("test-session-id");
    expect(session?.state).toBe("exited");
    expect(session?.exitCode).toBe(127);
  });

  it("validates configured Claude binary name in container during relaunch", async () => {
    launcher.setSettingsGetter(() => ({
      claudeBinary: "/opt/custom/claude-enterprise",
      codexBinary: "",
    }));

    await launcher.launch({
      cwd: "/tmp/project",
      containerId: "abc123def456",
      containerName: "companion-custom-claude",
    });

    mockIsContainerAlive.mockReturnValueOnce("running");
    mockHasBinaryInContainer.mockReturnValueOnce(false);

    // Resolve mock process exit so relaunch doesn't wait the 2s kill timeout
    exitResolve(0);
    const result = await launcher.relaunch("test-session-id");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("claude-enterprise");
    expect(mockHasBinaryInContainer).toHaveBeenCalledWith("abc123def456", "/opt/custom/claude-enterprise");
  });

  it("validates configured Codex binary name in container during relaunch", async () => {
    launcher.setSettingsGetter(() => ({
      claudeBinary: "",
      codexBinary: "/opt/custom/codex-enterprise --app-server",
    }));

    mockSpawn.mockReturnValueOnce(createMockCodexProc());
    await launcher.launch({
      backendType: "codex",
      cwd: "/tmp/project",
      containerId: "abc123def456",
      containerName: "companion-custom-codex",
      codexSandbox: "workspace-write",
    });

    mockIsContainerAlive.mockReturnValueOnce("running");
    mockHasBinaryInContainer.mockReturnValueOnce(false);

    // Resolve mock process exit so relaunch doesn't wait the 2s kill timeout
    exitResolve(0);
    const result = await launcher.relaunch("test-session-id");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("codex-enterprise");
    expect(mockHasBinaryInContainer).toHaveBeenCalledWith("abc123def456", "/opt/custom/codex-enterprise");
  });

  it("skips container validation for non-containerized sessions", async () => {
    // Create initial proc that exits when killed
    let resolveFirst: (code: number) => void;
    const firstProc = {
      pid: 12345,
      kill: vi.fn(() => {
        resolveFirst(0);
      }),
      exited: new Promise<number>((r) => {
        resolveFirst = r;
      }),
      stdout: null,
      stderr: null,
    };
    mockSpawn.mockReturnValueOnce(firstProc);

    await launcher.launch({ cwd: "/tmp/project" });

    const secondProc = createMockProc(54321);
    mockSpawn.mockReturnValueOnce(secondProc);

    const result = await launcher.relaunch("test-session-id");
    expect(result).toEqual({ ok: true });

    // Container validation methods should NOT have been called
    expect(mockIsContainerAlive).not.toHaveBeenCalled();
    expect(mockHasBinaryInContainer).not.toHaveBeenCalled();
  });

  // Regression: Bun.spawn throws ENOENT when the binary path is stale
  // (e.g. nvm version changed). The server must not crash.
  it("returns error gracefully when Bun.spawn throws ENOENT on Claude relaunch", async () => {
    let resolveFirst: (code: number) => void;
    const firstProc = {
      pid: 12345,
      kill: vi.fn(() => {
        resolveFirst(0);
      }),
      exited: new Promise<number>((r) => {
        resolveFirst = r;
      }),
      stdout: null,
      stderr: null,
    };
    mockSpawn.mockReturnValueOnce(firstProc);

    await launcher.launch({ cwd: "/tmp/project" });

    // On relaunch, Bun.spawn throws ENOENT (binary path gone).
    // Use persistent implementation (not once) to avoid order-dependent
    // consumption from unrelated async spawn attempts in prior tests.
    mockSpawn.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT: no such file or directory, posix_spawn '/usr/bin/claude'"), {
        code: "ENOENT",
      });
    });

    const result = await launcher.relaunch("test-session-id");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Failed to spawn process");

    const session = launcher.getSession("test-session-id");
    expect(session?.state).toBe("exited");
    expect(session?.exitCode).toBe(1);
  });

  it("returns error gracefully when Bun.spawn throws ENOENT on Codex relaunch", async () => {
    mockSpawn.mockReturnValueOnce(createMockCodexProc());
    await launcher.launch({
      backendType: "codex",
      cwd: "/tmp/project",
      codexSandbox: "workspace-write",
    });
    // Codex spawn is async; ensure the initial launch consumed the first spawn call
    // before swapping to the throwing implementation for relaunch.
    const deadline = Date.now() + 2000;
    while (mockSpawn.mock.calls.length < 1) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for initial Codex spawn");
      await new Promise<void>((r) => setTimeout(r, 10));
    }

    // On relaunch, Bun.spawn throws ENOENT (node binary path gone).
    // Use persistent implementation (not once) to keep this deterministic.
    mockSpawn.mockImplementation(() => {
      throw Object.assign(
        new Error("ENOENT: no such file or directory, posix_spawn '/home/user/.nvm/versions/node/v22/bin/node'"),
        { code: "ENOENT" },
      );
    });

    const result = await launcher.relaunch("test-session-id");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Failed to spawn process");

    const session = launcher.getSession("test-session-id");
    expect(session?.state).toBe("exited");
    expect(session?.exitCode).toBe(1);
  });

  it("kills a persisted stale pid during Codex relaunch even when no subprocess is tracked", async () => {
    // Simulates session-140-style launcher drift where the persisted launcher
    // state still points at an old Codex pid but this server instance has no
    // Subprocess handle for it.
    store.saveLauncher([
      {
        sessionId: "stale-codex",
        pid: 33333,
        state: "connected" as const,
        backendType: "codex" as const,
        cwd: "/tmp/project",
        createdAt: Date.now(),
        cliSessionId: "thread-stale",
        codexSandbox: "workspace-write" as const,
      },
    ]);
    await store.flushAll();

    let pidAlive = true;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      if (pid !== 33333) return true;
      if (signal === 0) {
        if (pidAlive) return true;
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      }
      if (signal === "SIGTERM") {
        pidAlive = false;
        return true;
      }
      return true;
    }) as any);

    mockSpawn.mockReturnValueOnce(createMockCodexProc(44444));
    const recovered = await launcher.restoreFromDisk();
    expect(recovered).toBe(1);

    const result = await launcher.relaunch("stale-codex");
    expect(result).toEqual({ ok: true });
    expect(killSpy).toHaveBeenCalledWith(33333, "SIGTERM");
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    killSpy.mockRestore();
  });

  it("does not escalate persisted stale pids to SIGKILL without a tracked subprocess", async () => {
    // Persisted PIDs can be recycled by the OS. We still send SIGTERM for
    // cleanup, but SIGKILL is reserved for live Subprocess handles that we
    // know belong to this launcher instance.
    store.saveLauncher([
      {
        sessionId: "stubborn-codex",
        pid: 44444,
        state: "connected" as const,
        backendType: "codex" as const,
        cwd: "/tmp/project",
        createdAt: Date.now(),
        cliSessionId: "thread-stubborn",
        codexSandbox: "workspace-write" as const,
      },
    ]);
    await store.flushAll();

    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      if (pid !== 44444) return true;
      if (signal === 0) return true;
      return true;
    }) as any);

    mockSpawn.mockReturnValueOnce(createMockCodexProc(55555));
    await launcher.restoreFromDisk();

    const result = await launcher.relaunch("stubborn-codex");
    expect(result).toEqual({ ok: true });
    expect(killSpy).toHaveBeenCalledWith(44444, "SIGTERM");
    expect(killSpy).not.toHaveBeenCalledWith(44444, "SIGKILL");

    killSpy.mockRestore();
  });

  // Regression: q-16 — old Codex process exit handler stomps new process state.
  // When relaunch kills the old process and spawns a new one, the old process's
  // proc.exited handler must not overwrite the new session state to "exited" or
  // delete the new process entry. This caused zombie sessions that appeared
  // running in the UI but rejected messages via takode send.
  it("ignores stale Codex proc.exited after relaunch spawns a new process", async () => {
    // Create a Codex process with controllable exit
    let resolveFirstExit: (code: number) => void;
    const firstProc = {
      pid: 11111,
      kill: vi.fn(),
      exited: new Promise<number>((r) => {
        resolveFirstExit = r;
      }),
      stdin: new WritableStream<Uint8Array>(),
      stdout: new ReadableStream<Uint8Array>(),
      stderr: new ReadableStream<Uint8Array>(),
    };
    mockSpawn.mockReturnValueOnce(firstProc);
    await launcher.launch({
      backendType: "codex",
      cwd: "/tmp/project",
      codexSandbox: "workspace-write",
    });

    // Wait for initial spawn to be consumed
    const deadline = Date.now() + 2000;
    while (mockSpawn.mock.calls.length < 1) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for initial Codex spawn");
      await new Promise<void>((r) => setTimeout(r, 10));
    }

    // Prepare second proc for relaunch
    const secondProc = createMockCodexProc(22222);
    mockSpawn.mockReturnValueOnce(secondProc);

    // Start relaunch (kills first proc, spawns second)
    // Resolve the first proc's exit during terminateKnownProcess
    firstProc.kill.mockImplementation(() => {
      resolveFirstExit(143);
    });
    const result = await launcher.relaunch("test-session-id");
    expect(result).toEqual({ ok: true });

    // At this point, the new process should be tracked
    const session = launcher.getSession("test-session-id");
    expect(session?.state).toBe("connected");
    expect(session?.pid).toBe(22222);

    // Now simulate the OLD process's stale exit handler firing late
    // (this happens if the exit promise resolves after relaunch completes).
    // The old handler MUST be guarded — it should NOT stomp state.
    resolveFirstExit!(143);
    await new Promise<void>((r) => setTimeout(r, 50)); // flush microtasks

    // Session should STILL be connected with the new process
    const afterStaleExit = launcher.getSession("test-session-id");
    expect(afterStaleExit?.state).toBe("connected");
    expect(afterStaleExit?.pid).toBe(22222);
    expect(launcher.isAlive("test-session-id")).toBe(true);
  });

  // Regression: q-16 — relaunch should notify ws-bridge before killing old
  // Codex process so the disconnect handler knows it's intentional.
  it("calls onBeforeRelaunch callback before killing old process", async () => {
    let resolveFirst: (code: number) => void;
    const firstProc = {
      pid: 12345,
      kill: vi.fn(() => {
        resolveFirst(0);
      }),
      exited: new Promise<number>((r) => {
        resolveFirst = r;
      }),
      stdin: new WritableStream<Uint8Array>(),
      stdout: new ReadableStream<Uint8Array>(),
      stderr: new ReadableStream<Uint8Array>(),
    };
    mockSpawn.mockReturnValueOnce(firstProc);
    await launcher.launch({
      backendType: "codex",
      cwd: "/tmp/project",
      codexSandbox: "workspace-write",
    });

    // Wait for initial spawn
    const deadline = Date.now() + 2000;
    while (mockSpawn.mock.calls.length < 1) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for initial Codex spawn");
      await new Promise<void>((r) => setTimeout(r, 10));
    }

    // Register the onBeforeRelaunch callback
    const beforeRelaunchCb = vi.fn();
    launcher.onBeforeRelaunchCallback(beforeRelaunchCb);

    mockSpawn.mockReturnValueOnce(createMockCodexProc(54321));
    await launcher.relaunch("test-session-id");

    // Callback should have been called with session ID and backend type
    expect(beforeRelaunchCb).toHaveBeenCalledWith("test-session-id", "codex");
    // And it should have been called BEFORE kill (verify kill was called after)
    expect(firstProc.kill).toHaveBeenCalled();
  });

  it("relaunches host Codex sessions without hot-path shell capture", async () => {
    mockCaptureUserShellPath.mockImplementation(() => {
      throw new Error("host Codex relaunch should not re-capture shell PATH");
    });
    mockCaptureUserShellEnv.mockImplementation(() => {
      throw new Error("host Codex relaunch should not re-capture shell env");
    });
    mockGetEnrichedPath.mockReturnValue("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
    process.env.LITELLM_PROXY_URL = "https://proxy.example";

    let resolveFirst: (code: number) => void;
    const firstProc = {
      pid: 12345,
      kill: vi.fn(() => {
        resolveFirst(0);
      }),
      exited: new Promise<number>((r) => {
        resolveFirst = r;
      }),
      stdin: new WritableStream<Uint8Array>(),
      stdout: new ReadableStream<Uint8Array>(),
      stderr: new ReadableStream<Uint8Array>(),
    };
    mockSpawn.mockReturnValueOnce(firstProc);
    await launcher.launch({
      backendType: "codex",
      cwd: "/tmp/project",
      codexSandbox: "workspace-write",
    });

    const deadline = Date.now() + 2000;
    while (mockSpawn.mock.calls.length < 1) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for initial Codex spawn");
      await new Promise<void>((r) => setTimeout(r, 10));
    }

    mockSpawn.mockReturnValueOnce(createMockCodexProc(54321));
    const result = await launcher.relaunch("test-session-id");

    expect(result).toEqual({ ok: true });
    const [, relaunchOptions] = mockSpawn.mock.calls[1];
    expect(relaunchOptions.env.LITELLM_PROXY_URL).toBe("https://proxy.example");
    expect(mockCaptureUserShellPath).not.toHaveBeenCalled();
    expect(mockCaptureUserShellEnv).not.toHaveBeenCalled();
  });

  // Regression: q-110 — without orchestrator guardrails, relaunched leaders
  // lose Quest Journey stages, worker selection rules, and skeptic review
  // workflows, breaking all orchestration coordination.
  it("re-injects orchestrator guardrails into system prompt on relaunch", async () => {
    // Launch as an orchestrator — pass extraInstructions via launch options
    const orchestratorGuardrails = launcher.getOrchestratorGuardrails("claude");
    let resolveFirst: (code: number) => void;
    const firstProc = {
      pid: 12345,
      kill: vi.fn(() => {
        resolveFirst(0);
      }),
      exited: new Promise<number>((r) => {
        resolveFirst = r;
      }),
      stdout: null,
      stderr: null,
    };
    mockSpawn.mockReturnValueOnce(firstProc);

    const session = await launcher.launch({
      cwd: "/tmp/project",
      extraInstructions: orchestratorGuardrails,
    });
    session.isOrchestrator = true;
    launcher.setCLISessionId("test-session-id", "cli-orch-id");

    // Verify initial launch includes guardrails in --append-system-prompt
    const [initialCmd] = mockSpawn.mock.calls[0];
    const initialSysPromptIdx = initialCmd.indexOf("--append-system-prompt");
    expect(initialSysPromptIdx).toBeGreaterThan(-1);
    const initialSysPrompt = initialCmd[initialSysPromptIdx + 1] as string;
    expect(initialSysPrompt).toContain("Takode");

    // Relaunch the session
    const secondProc = createMockProc(54321);
    mockSpawn.mockReturnValueOnce(secondProc);
    const result = await launcher.relaunch("test-session-id");
    expect(result).toEqual({ ok: true });

    // Relaunched CLI must also have --append-system-prompt with guardrails
    const [relaunchCmd] = mockSpawn.mock.calls[1];
    const relaunchSysPromptIdx = relaunchCmd.indexOf("--append-system-prompt");
    expect(relaunchSysPromptIdx).toBeGreaterThan(-1);
    const relaunchSysPrompt = relaunchCmd[relaunchSysPromptIdx + 1] as string;
    expect(relaunchSysPrompt).toContain("Takode");
    expect(relaunchSysPrompt).toContain("Quest Journey");
    expect(relaunchSysPrompt).toContain("Code Review");
  });

  it("does not inject orchestrator guardrails for non-orchestrator sessions on relaunch", async () => {
    let resolveFirst: (code: number) => void;
    const firstProc = {
      pid: 12345,
      kill: vi.fn(() => {
        resolveFirst(0);
      }),
      exited: new Promise<number>((r) => {
        resolveFirst = r;
      }),
      stdout: null,
      stderr: null,
    };
    mockSpawn.mockReturnValueOnce(firstProc);

    await launcher.launch({ cwd: "/tmp/project" });
    launcher.setCLISessionId("test-session-id", "cli-worker-id");

    // Relaunch a non-orchestrator session
    const secondProc = createMockProc(54321);
    mockSpawn.mockReturnValueOnce(secondProc);
    const result = await launcher.relaunch("test-session-id");
    expect(result).toEqual({ ok: true });

    // The system prompt should still exist (link syntax etc.) but NOT contain
    // orchestrator guardrails -- assert unconditionally to catch regressions
    // where the flag disappears entirely.
    const [relaunchCmd] = mockSpawn.mock.calls[1];
    const sysPromptIdx = relaunchCmd.indexOf("--append-system-prompt");
    expect(sysPromptIdx).toBeGreaterThan(-1);
    const sysPrompt = relaunchCmd[sysPromptIdx + 1] as string;
    expect(sysPrompt).not.toContain("Quest Journey");
    expect(sysPrompt).not.toContain("Code Review");
  });
});
