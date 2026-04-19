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

describe("launch", () => {
  it("creates a session with a UUID and starting state", async () => {
    const info = await launcher.launch({ cwd: "/tmp/project" });

    expect(info.sessionId).toBe("test-session-id");
    expect(info.state).toBe("starting");
    expect(info.cwd).toBe("/tmp/project");
    expect(info.createdAt).toBeGreaterThan(0);
  });

  it("injects server-issued auth env vars into launched sessions", async () => {
    await launcher.launch({ cwd: "/tmp/project" });

    const [, options] = mockSpawn.mock.calls[0];
    expect(options.env.COMPANION_SERVER_ID).toBe("test-server-id");
    expect(options.env.COMPANION_SESSION_ID).toBe("test-session-id");
    expect(options.env.COMPANION_SESSION_NUMBER).toBeDefined();
    expect(typeof options.env.COMPANION_AUTH_TOKEN).toBe("string");
    expect(options.env.COMPANION_AUTH_TOKEN.length).toBeGreaterThan(0);
    expect(launcher.verifySessionAuthToken("test-session-id", options.env.COMPANION_AUTH_TOKEN)).toBe(true);
  });

  it("writes session-auth to centralized ~/.companion/session-auth/ directory", async () => {
    mockResolveBinary.mockReturnValue("/opt/fake/codex");
    mockSpawn.mockReturnValueOnce(createMockCodexProc());
    await launcher.launch({ backendType: "codex", cwd: "/tmp/project" });

    // The auth file is written to ~/.companion/session-auth/<hash>-<serverId>.json
    const { getSessionAuthPath } = await import("../shared/session-auth.js");
    const expectedPath = getSessionAuthPath("/tmp/project", "test-server-id");
    const deadline = Date.now() + 1000;
    while (!mockWriteFile.mock.calls.some((call) => call[0] === expectedPath)) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for session-auth write");
      await new Promise<void>((r) => setTimeout(r, 10));
    }

    const writeCall = mockWriteFile.mock.calls.find((call) => call[0] === expectedPath);
    expect(writeCall).toBeDefined();
    // Should create the ~/.companion/session-auth/ directory, not {cwd}/.companion/
    expect(mockMkdir).toHaveBeenCalledWith(join(homedir(), ".companion", "session-auth"), { recursive: true });
    expect(writeCall?.[2]).toEqual({ mode: 0o600 });

    const payload = JSON.parse(String(writeCall?.[1])) as {
      sessionId: string;
      authToken: string;
      port: number;
      serverId: string;
    };
    expect(payload.sessionId).toBe("test-session-id");
    expect(payload.authToken.length).toBeGreaterThan(0);
    expect(payload.port).toBe(3456);
    expect(payload.serverId).toBe("test-server-id");
  });

  it("spawns CLI with correct --sdk-url and flags", async () => {
    await launcher.launch({ cwd: "/tmp/project" });

    expect(mockSpawn).toHaveBeenCalledOnce();
    const [cmdAndArgs, options] = mockSpawn.mock.calls[0];

    // Binary should be resolved via execSync
    expect(cmdAndArgs[0]).toBe("/usr/bin/claude");

    // Core required flags
    expect(cmdAndArgs).toContain("--sdk-url");
    expect(cmdAndArgs).toContain("ws://localhost:3456/ws/cli/test-session-id");
    expect(cmdAndArgs).toContain("--print");
    expect(cmdAndArgs).toContain("--output-format");
    expect(cmdAndArgs).toContain("stream-json");
    expect(cmdAndArgs).toContain("--input-format");
    expect(cmdAndArgs).toContain("--verbose");

    // Headless prompt
    expect(cmdAndArgs).toContain("-p");
    expect(cmdAndArgs).toContain("");

    // Spawn options
    expect(options.cwd).toBe("/tmp/project");
    expect(options.stdout).toBe("pipe");
    expect(options.stderr).toBe("pipe");
  });

  it("passes --model when provided", async () => {
    await launcher.launch({ model: "claude-opus-4-20250514", cwd: "/tmp" });

    const [cmdAndArgs] = mockSpawn.mock.calls[0];
    const modelIdx = cmdAndArgs.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(cmdAndArgs[modelIdx + 1]).toBe("claude-opus-4-20250514");
  });

  it("passes --permission-mode when provided", async () => {
    await launcher.launch({ permissionMode: "bypassPermissions", cwd: "/tmp" });

    const [cmdAndArgs] = mockSpawn.mock.calls[0];
    const modeIdx = cmdAndArgs.indexOf("--permission-mode");
    expect(modeIdx).toBeGreaterThan(-1);
    expect(cmdAndArgs[modeIdx + 1]).toBe("bypassPermissions");
  });

  it("downgrades bypassPermissions to acceptEdits for containerized Claude sessions", async () => {
    await launcher.launch({
      cwd: "/tmp/project",
      permissionMode: "bypassPermissions",
      containerId: "abc123def456",
      containerName: "companion-test",
    });

    const [cmdAndArgs] = mockSpawn.mock.calls[0];
    // With bash -lc wrapping, CLI args are in the last element as a single string
    const bashCmd = cmdAndArgs[cmdAndArgs.length - 1];
    expect(bashCmd).toContain("--permission-mode");
    expect(bashCmd).toContain("acceptEdits");
    expect(bashCmd).not.toContain("bypassPermissions");
  });

  it("uses COMPANION_CONTAINER_SDK_HOST for containerized sdk-url when set", async () => {
    process.env.COMPANION_CONTAINER_SDK_HOST = "172.17.0.1";
    await launcher.launch({
      cwd: "/tmp/project",
      containerId: "abc123def456",
      containerName: "companion-test",
    });

    const [cmdAndArgs] = mockSpawn.mock.calls[0];
    // With bash -lc wrapping, CLI args are in the last element as a single string
    const bashCmd = cmdAndArgs[cmdAndArgs.length - 1];
    expect(bashCmd).toContain("--sdk-url");
    expect(bashCmd).toContain("ws://172.17.0.1:3456/ws/cli/test-session-id");
  });

  it("passes --allowedTools for each tool", async () => {
    await launcher.launch({
      allowedTools: ["Read", "Write", "Bash"],
      cwd: "/tmp",
    });

    const [cmdAndArgs] = mockSpawn.mock.calls[0];
    // Each tool gets its own --allowedTools flag
    const toolFlags = cmdAndArgs.reduce((acc: string[], arg: string, i: number) => {
      if (arg === "--allowedTools") acc.push(cmdAndArgs[i + 1]);
      return acc;
    }, []);
    expect(toolFlags).toEqual(["Read", "Write", "Bash"]);
  });

  it("resolves binary path via resolveBinary when not absolute", async () => {
    mockResolveBinary.mockReturnValue("/usr/local/bin/claude-dev");
    await launcher.launch({ claudeBinary: "claude-dev", cwd: "/tmp" });

    expect(mockResolveBinary).toHaveBeenCalledWith("claude-dev");
    const [cmdAndArgs] = mockSpawn.mock.calls[0];
    expect(cmdAndArgs[0]).toBe("/usr/local/bin/claude-dev");
  });

  it("passes absolute binary path directly to resolveBinary", async () => {
    mockResolveBinary.mockReturnValue("/opt/bin/claude");
    await launcher.launch({
      claudeBinary: "/opt/bin/claude",
      cwd: "/tmp",
    });

    expect(mockResolveBinary).toHaveBeenCalledWith("/opt/bin/claude");
    const [cmdAndArgs] = mockSpawn.mock.calls[0];
    expect(cmdAndArgs[0]).toBe("/opt/bin/claude");
  });

  it("sets state=exited and exitCode=127 when claude binary not found", async () => {
    mockResolveBinary.mockReturnValue(null);

    const info = await launcher.launch({ cwd: "/tmp" });

    expect(info.state).toBe("exited");
    expect(info.exitCode).toBe(127);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("stores container metadata when containerId provided", async () => {
    const info = await launcher.launch({
      cwd: "/tmp/project",
      containerId: "abc123def456",
      containerName: "companion-session-1",
      containerImage: "ubuntu:22.04",
    });

    expect(info.containerId).toBe("abc123def456");
    expect(info.containerName).toBe("companion-session-1");
    expect(info.containerImage).toBe("ubuntu:22.04");
  });

  it("uses docker exec -i with bash -lc for containerized Claude sessions", async () => {
    // bash -lc ensures ~/.bashrc is sourced so nvm-installed CLIs are on PATH
    await launcher.launch({
      cwd: "/tmp/project",
      containerId: "abc123def456",
      containerName: "companion-session-1",
    });

    const [cmdAndArgs] = mockSpawn.mock.calls[0];
    expect(cmdAndArgs[0]).toBe("docker");
    expect(cmdAndArgs[1]).toBe("exec");
    expect(cmdAndArgs[2]).toBe("-i");
    // Should wrap the CLI command in bash -lc for login shell PATH
    expect(cmdAndArgs).toContain("bash");
    expect(cmdAndArgs).toContain("-lc");
  });

  it("sets session pid from spawned process", async () => {
    mockSpawn.mockReturnValue(createMockProc(99999));
    const info = await launcher.launch({ cwd: "/tmp" });
    expect(info.pid).toBe(99999);
  });

  it("unsets CLAUDECODE to avoid CLI nesting guard", async () => {
    await launcher.launch({ cwd: "/tmp" });

    const [, options] = mockSpawn.mock.calls[0];
    expect(options.env.CLAUDECODE).toBeUndefined();
  });

  it("merges custom env variables", async () => {
    await launcher.launch({
      cwd: "/tmp",
      env: { MY_VAR: "hello" },
    });

    const [, options] = mockSpawn.mock.calls[0];
    expect(options.env.MY_VAR).toBe("hello");
    expect(options.env.CLAUDECODE).toBeUndefined();
  });

  // spawnCodex is async (prepareCodexHome uses async fs), so wait for the
  // actual spawn call instead of a fixed delay to avoid timing flakes.
  const waitForSpawnCalls = async (count: number) => {
    const deadline = Date.now() + 2000;
    while (mockSpawn.mock.calls.length < count) {
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${count} spawn calls`);
      }
      await new Promise<void>((r) => setTimeout(r, 10));
    }
  };

  it("enables Codex web search when codexInternetAccess=true", async () => {
    // Use a fake path where no sibling `node` exists, so the spawn uses
    // the codex binary directly (the explicit-node path is tested separately).
    const cwd = "/tmp/project-web-on";
    mockResolveBinary.mockReturnValue("/opt/fake/codex");
    mockSpawn.mockReturnValueOnce(createMockCodexProc());

    await launcher.launch({
      backendType: "codex",
      cwd,
      codexInternetAccess: true,
      codexSandbox: "danger-full-access",
    });
    await waitForSpawnCalls(1);

    const matchingCall = mockSpawn.mock.calls.find(([, options]) => options.cwd === cwd);
    expect(matchingCall).toBeDefined();
    const [cmdAndArgs, options] = matchingCall!;
    expect(cmdAndArgs[0]).toBe("/opt/fake/codex");
    expect(cmdAndArgs).toContain("app-server");
    expect(cmdAndArgs).toContain("-c");
    expect(cmdAndArgs.join(" ")).toContain("tools.webSearch=true");
    expect(options.cwd).toBe(cwd);
  });

  it("disables Codex web search when codexInternetAccess=false", async () => {
    const cwd = "/tmp/project-web-off";
    mockResolveBinary.mockReturnValue("/opt/fake/codex");
    mockSpawn.mockReturnValueOnce(createMockCodexProc());

    await launcher.launch({
      backendType: "codex",
      cwd,
      codexInternetAccess: false,
      codexSandbox: "workspace-write",
    });
    await waitForSpawnCalls(1);

    const matchingCall = mockSpawn.mock.calls.find(([, options]) => options.cwd === cwd);
    expect(matchingCall).toBeDefined();
    const [cmdAndArgs] = matchingCall!;
    expect(cmdAndArgs).toContain("app-server");
    expect(cmdAndArgs).toContain("-c");
    expect(cmdAndArgs.join(" ")).toContain("tools.webSearch=false");
  });

  it("maps bypassPermissions to Codex never-ask launch flags", async () => {
    mockResolveBinary.mockReturnValue("/opt/fake/codex");
    mockSpawn.mockReturnValueOnce(createMockCodexProc());

    await launcher.launch({
      backendType: "codex",
      cwd: "/tmp/project",
      permissionMode: "bypassPermissions",
      codexInternetAccess: false,
    });
    await waitForSpawnCalls(1);

    const [cmdAndArgs] = mockSpawn.mock.calls[0];
    const approvalIdx = cmdAndArgs.indexOf("-a");
    const sandboxIdx = cmdAndArgs.indexOf("-s");
    expect(approvalIdx).toBeGreaterThan(-1);
    expect(cmdAndArgs[approvalIdx + 1]).toBe("never");
    expect(sandboxIdx).toBeGreaterThan(-1);
    expect(cmdAndArgs[sandboxIdx + 1]).toBe("danger-full-access");
  });

  it("uses -a never for codex plan mode when askPermission is false", async () => {
    mockResolveBinary.mockReturnValue("/opt/fake/codex");
    mockSpawn.mockReturnValueOnce(createMockCodexProc());

    await launcher.launch({
      backendType: "codex",
      cwd: "/tmp/project",
      permissionMode: "plan",
      askPermission: false,
      codexInternetAccess: false,
      codexSandbox: "workspace-write",
    });
    await waitForSpawnCalls(1);

    const [cmdAndArgs] = mockSpawn.mock.calls[0];
    const approvalIdx = cmdAndArgs.indexOf("-a");
    const sandboxIdx = cmdAndArgs.indexOf("-s");
    expect(approvalIdx).toBeGreaterThan(-1);
    expect(cmdAndArgs[approvalIdx + 1]).toBe("never");
    expect(sandboxIdx).toBeGreaterThan(-1);
    expect(cmdAndArgs[sandboxIdx + 1]).toBe("workspace-write");
  });

  it("maps non-bypass modes to Codex untrusted launch policy", async () => {
    mockResolveBinary.mockReturnValue("/opt/fake/codex");
    mockSpawn.mockReturnValueOnce(createMockCodexProc());

    await launcher.launch({
      backendType: "codex",
      cwd: "/tmp/project",
      permissionMode: "suggest",
      codexInternetAccess: false,
    });
    await waitForSpawnCalls(1);

    const [cmdAndArgs] = mockSpawn.mock.calls[0];
    const approvalIdx = cmdAndArgs.indexOf("-a");
    const sandboxIdx = cmdAndArgs.indexOf("-s");
    expect(approvalIdx).toBeGreaterThan(-1);
    expect(cmdAndArgs[approvalIdx + 1]).toBe("untrusted");
    expect(sandboxIdx).toBeGreaterThan(-1);
    expect(cmdAndArgs[sandboxIdx + 1]).toBe("workspace-write");
  });

  it("passes Codex reasoning effort via config flag when provided", async () => {
    mockResolveBinary.mockReturnValue("/opt/fake/codex");
    mockSpawn.mockReturnValueOnce(createMockCodexProc());

    await launcher.launch({
      backendType: "codex",
      cwd: "/tmp/project",
      codexReasoningEffort: "high",
      codexSandbox: "workspace-write",
    });
    await waitForSpawnCalls(1);

    const [cmdAndArgs] = mockSpawn.mock.calls[0];
    expect(cmdAndArgs).toContain("app-server");
    expect(cmdAndArgs).toContain("-c");
    expect(cmdAndArgs).toContain("model_reasoning_effort=high");
  });

  it("logs session stderr with the human session number when available", async () => {
    // The production log viewer should show #N labels for session stream output instead of raw UUIDs.
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let stderrController: ReadableStreamDefaultController<Uint8Array> | null = null;
    mockSpawn.mockReturnValueOnce({
      pid: 33333,
      kill: vi.fn(),
      exited: new Promise<number>(() => {}),
      stdin: new WritableStream<Uint8Array>(),
      stdout: new ReadableStream<Uint8Array>(),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          stderrController = controller;
        },
      }),
    });

    await launcher.launch({
      backendType: "codex",
      cwd: "/tmp/project",
      codexSandbox: "workspace-write",
    });
    await waitForSpawnCalls(1);
    const sessionNum = launcher.getSessionNum("test-session-id");

    expect(stderrController).not.toBeNull();
    stderrController!.enqueue(new TextEncoder().encode("token expired\n"));
    stderrController!.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(stderrSpy).toHaveBeenCalledWith(`[session:#${sessionNum}:stderr] token expired`);
    stderrSpy.mockRestore();
  });

  it("uses a cached native Codex artifact when the resolved binary is a bootstrap wrapper", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "codex-bootstrap-test-"));
    const wrapperPath = join(fixtureRoot, "codex-wrapper");
    const cacheRoot = join(fixtureRoot, "dotslash-cache");
    const artifactDir = join(cacheRoot, "aa", "bb");
    const artifactPath = join(artifactDir, "codex");
    const { mkdirSync: realMkdirSync, writeFileSync: realWriteFileSync } = require("node:fs");
    const originalDotslashCache = process.env.DOTSLASH_CACHE;

    realWriteFileSync(
      wrapperPath,
      ["#!/usr/bin/env python3", 'CACHE_DIR = os.path.expanduser("~/.cache/codex")', ""].join("\n"),
      "utf-8",
    );
    realMkdirSync(artifactDir, { recursive: true });
    realWriteFileSync(artifactPath, "#!/bin/sh\n", "utf-8");

    process.env.DOTSLASH_CACHE = cacheRoot;
    mockResolveBinary.mockReturnValue(wrapperPath);
    mockSpawn.mockReturnValueOnce(createMockCodexProc());

    try {
      await launcher.launch({
        backendType: "codex",
        cwd: "/tmp/project",
        codexSandbox: "workspace-write",
      });
      await waitForSpawnCalls(1);

      const [cmdAndArgs, options] = mockSpawn.mock.calls[0];
      expect(cmdAndArgs[0]).toBe(artifactPath);
      expect(options.env.DOTSLASH_CACHE).toBe(cacheRoot);
    } finally {
      if (originalDotslashCache === undefined) {
        delete process.env.DOTSLASH_CACHE;
      } else {
        process.env.DOTSLASH_CACHE = originalDotslashCache;
      }
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("enables Codex native multi-agent support in per-session config", async () => {
    mockResolveBinary.mockReturnValue("/opt/fake/codex");
    mockSpawn.mockReturnValueOnce(createMockCodexProc());

    const customHome = mkdtempSync(join(tmpdir(), "codex-home-test-"));
    const sessionHome = join(customHome, "test-session-id");
    const configPath = join(sessionHome, "config.toml");
    const { readFileSync: realReadFileSync } = require("node:fs");

    try {
      await launcher.launch({
        backendType: "codex",
        cwd: "/tmp/project",
        codexSandbox: "workspace-write",
        codexHome: customHome,
      });
      await waitForSpawnCalls(1);

      const updatedConfig = realReadFileSync(configPath, "utf-8");
      expect(updatedConfig).toContain("[features]");
      expect(updatedConfig).toContain("multi_agent = true");
      expect(updatedConfig).toContain("[shell_environment_policy]");
      expect(updatedConfig).toContain('"PATH"');
    } finally {
      rmSync(customHome, { recursive: true, force: true });
    }
  });

  it("refreshes auth.json from the legacy Codex home even when the session copy already exists", async () => {
    mockResolveBinary.mockReturnValue("/opt/fake/codex");
    mockSpawn.mockReturnValueOnce(createMockCodexProc());

    const legacyHome = join(homedir(), ".codex");
    const sessionHome = join(homedir(), ".companion", "codex-home", "test-session-id");
    const legacyAuth = join(legacyHome, "auth.json");
    const sessionAuth = join(sessionHome, "auth.json");

    mockExistsSync.mockImplementation((path: string) => {
      if (path === legacyHome) return true;
      if (path === legacyAuth) return true;
      if (path === sessionAuth) return true;
      return false;
    });

    await launcher.launch({
      backendType: "codex",
      cwd: "/tmp/project",
      codexSandbox: "workspace-write",
    });
    await waitForSpawnCalls(1);

    expect(mockCopyFile).toHaveBeenCalledWith(legacyAuth, sessionAuth);
  });

  it("prunes broken legacy skill symlinks from the session Codex home", async () => {
    // q-275: stale broken symlinks in ~/.codex/skills should not be copied into
    // every per-session Codex home, or each relaunch will spam skill-load errors.
    mockResolveBinary.mockReturnValue("/opt/fake/codex");
    mockSpawn.mockReturnValueOnce(createMockCodexProc());

    const legacyHome = join(homedir(), ".codex");
    const legacySkills = join(legacyHome, "skills");
    const sessionSkills = join(homedir(), ".companion", "codex-home", "test-session-id", "skills");
    const brokenSkill = join(sessionSkills, "cron-scheduling");

    mockExistsSync.mockImplementation((path: string) => {
      if (path === legacyHome) return true;
      if (path === legacySkills) return true;
      return false;
    });
    mockReaddir.mockImplementation(async (path: string, options?: { withFileTypes?: boolean }) => {
      if (path === sessionSkills && options?.withFileTypes) {
        return [
          {
            name: "cron-scheduling",
            isSymbolicLink: () => true,
            isDirectory: () => false,
          },
        ];
      }
      return [];
    });
    mockRealpath.mockImplementation(async (path: string) => {
      if (path === brokenSkill) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return path;
    });

    await launcher.launch({
      backendType: "codex",
      cwd: "/tmp/project",
      codexSandbox: "workspace-write",
    });
    await waitForSpawnCalls(1);

    expect(mockCp).toHaveBeenCalledWith(legacySkills, sessionSkills, { recursive: true });
    expect(mockUnlink).toHaveBeenCalledWith(brokenSkill);
  });

  it("prunes broken skill symlinks from an existing session Codex home on relaunch", async () => {
    // q-275 follow-up: once a session-specific skills/ directory already exists,
    // relaunch must still clean stale broken symlinks instead of only fixing the
    // first bootstrap copy.
    mockResolveBinary.mockReturnValue("/opt/fake/codex");
    mockSpawn.mockReturnValueOnce(createMockCodexProc());

    const legacyHome = join(homedir(), ".codex");
    const sessionHome = join(homedir(), ".companion", "codex-home", "test-session-id");
    const sessionSkills = join(sessionHome, "skills");
    const brokenSkill = join(sessionSkills, "cron-scheduling");

    mockExistsSync.mockImplementation((path: string) => {
      if (path === legacyHome) return true;
      if (path === sessionSkills) return true;
      return false;
    });
    mockReaddir.mockImplementation(async (path: string, options?: { withFileTypes?: boolean }) => {
      if (path === sessionSkills && options?.withFileTypes) {
        return [
          {
            name: "cron-scheduling",
            isSymbolicLink: () => true,
            isDirectory: () => false,
          },
        ];
      }
      return [];
    });
    mockRealpath.mockImplementation(async (path: string) => {
      if (path === brokenSkill) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return path;
    });

    await launcher.launch({
      backendType: "codex",
      cwd: "/tmp/project",
      codexSandbox: "workspace-write",
    });
    await waitForSpawnCalls(1);

    expect(mockCp).not.toHaveBeenCalledWith(join(legacyHome, "skills"), sessionSkills, { recursive: true });
    expect(mockUnlink).toHaveBeenCalledWith(brokenSkill);
  });

  it("seeds the matching Codex rollout file into the session home for external resume", async () => {
    mockResolveBinary.mockReturnValue("/opt/fake/codex");
    mockSpawn.mockReturnValueOnce(createMockCodexProc());

    const legacyHome = join(homedir(), ".codex");
    const sessionsRoot = join(legacyHome, "sessions");
    const yearPath = join(sessionsRoot, "2026");
    const monthPath = join(yearPath, "04");
    const dayPath = join(monthPath, "01");
    const rolloutName = "rollout-2026-04-01T00-42-45-thread-abc.jsonl";
    const rolloutPath = join(dayPath, rolloutName);
    const sessionHome = join(homedir(), ".companion", "codex-home", "test-session-id");
    const seededRollout = join(sessionHome, "sessions", "2026", "04", "01", rolloutName);

    mockExistsSync.mockImplementation((path: string) => {
      if (path === legacyHome) return true;
      return false;
    });
    mockReaddir.mockImplementation(async (path: string): Promise<any> => {
      if (path === sessionsRoot) return ["2026"];
      if (path === yearPath) return ["04"];
      if (path === monthPath) return ["01"];
      if (path === dayPath) return [rolloutName];
      return [];
    });
    mockStat.mockImplementation(async (path: string) => {
      if (path === rolloutPath) {
        return {
          isFile: () => true,
          mtimeMs: 42,
        };
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    await launcher.launch({
      backendType: "codex",
      cwd: "/tmp/project",
      codexSandbox: "workspace-write",
      resumeCliSessionId: "thread-abc",
    });
    await waitForSpawnCalls(1);

    expect(mockCopyFile).toHaveBeenCalledWith(rolloutPath, seededRollout);
  });

  it("preserves Companion/Takode env vars in Codex shell policy for orchestrators", async () => {
    mockResolveBinary.mockReturnValue("/opt/fake/codex");
    mockSpawn.mockReturnValueOnce(createMockCodexProc());

    const customHome = mkdtempSync(join(tmpdir(), "codex-home-test-"));
    const sessionHome = join(customHome, "test-session-id");
    const configPath = join(sessionHome, "config.toml");
    const {
      mkdirSync: realMkdirSync,
      writeFileSync: realWriteFileSync,
      readFileSync: realReadFileSync,
    } = require("node:fs");
    realMkdirSync(sessionHome, { recursive: true });
    realWriteFileSync(
      configPath,
      [
        'sandbox_mode = "workspace-write"',
        "",
        "[features]",
        "multi_agent = false",
        "other_feature = false",
        "",
        "[shell_environment_policy]",
        'inherit = "core"',
        "include_only = [",
        '    "PATH",',
        '    "HOME",',
        "]",
        "",
      ].join("\n"),
      "utf-8",
    );

    try {
      await launcher.launch({
        backendType: "codex",
        cwd: "/tmp/project",
        codexSandbox: "workspace-write",
        codexHome: customHome,
        env: {
          COMPANION_PORT: "3456",
          TAKODE_ROLE: "orchestrator",
          TAKODE_API_PORT: "3456",
        },
      });
      await waitForSpawnCalls(1);

      const [cmdAndArgs, options] = mockSpawn.mock.calls[0];
      expect(cmdAndArgs).toContain("app-server");
      expect(options.env.COMPANION_SERVER_ID).toBe("test-server-id");
      expect(options.env.COMPANION_SESSION_ID).toBe("test-session-id");
      expect(options.env.COMPANION_SESSION_NUMBER).toBeDefined();

      const updatedConfig = realReadFileSync(configPath, "utf-8");
      expect(updatedConfig).toContain("[features]");
      expect(updatedConfig).toContain("multi_agent = true");
      expect(updatedConfig).not.toContain("multi_agent = false");
      expect(updatedConfig).toContain("other_feature = false");
      expect(updatedConfig).toContain('"PATH"');
      expect(updatedConfig).toContain('"HOME"');
      expect(updatedConfig).toContain('"COMPANION_SERVER_ID"');
      expect(updatedConfig).toContain('"COMPANION_SESSION_ID"');
      expect(updatedConfig).toContain('"COMPANION_SESSION_NUMBER"');
      expect(updatedConfig).toContain('"COMPANION_AUTH_TOKEN"');
      expect(updatedConfig).toContain('"COMPANION_PORT"');
      expect(updatedConfig).toContain('"TAKODE_ROLE"');
      expect(updatedConfig).toContain('"TAKODE_API_PORT"');
    } finally {
      rmSync(customHome, { recursive: true, force: true });
    }
  });

  it("preserves built-in shim directories for host Codex sessions", async () => {
    mockResolveBinary.mockReturnValue("/opt/fake/codex");
    mockSpawn.mockReturnValueOnce(createMockCodexProc());
    mockCaptureUserShellPath.mockReturnValue("/opt/homebrew/bin:/Users/test/.bun/bin:/usr/bin:/bin");
    mockGetEnrichedPath.mockReturnValue("/usr/local/share/companion-extra:/usr/bin:/bin");

    await launcher.launch({
      backendType: "codex",
      cwd: "/tmp/project",
      codexInternetAccess: true,
      codexSandbox: "workspace-write",
    });
    await waitForSpawnCalls(1);

    const [, options] = mockSpawn.mock.calls[0];
    const dirs = options.env.PATH.split(":");
    expect(dirs.slice(0, 6)).toEqual([
      "/opt/fake",
      join(homedir(), ".companion", "bin"),
      join(homedir(), ".local", "bin"),
      join(homedir(), ".bun", "bin"),
      "/opt/homebrew/bin",
      "/Users/test/.bun/bin",
    ]);
    expect(dirs).toContain("/usr/local/share/companion-extra");
  });

  it("spawns codex via sibling node binary to bypass shebang issues", async () => {
    // When a `node` binary exists next to the resolved `codex`, the launcher
    // should invoke `node <codex-script>` directly instead of relying on
    // the #!/usr/bin/env node shebang (which may resolve to system Node v12).
    // Create a temp dir with both `codex` and `node` files to simulate nvm layout.
    const tmpBinDir = mkdtempSync(join(tmpdir(), "codex-test-"));
    const fakeCodex = join(tmpBinDir, "codex");
    const fakeNode = join(tmpBinDir, "node");
    const { writeFileSync: realWriteFileSync } = require("node:fs");
    realWriteFileSync(fakeCodex, "#!/usr/bin/env node\n");
    realWriteFileSync(fakeNode, "#!/bin/sh\n");

    mockResolveBinary.mockReturnValue(fakeCodex);
    mockSpawn.mockReturnValueOnce(createMockCodexProc());

    await launcher.launch({
      backendType: "codex",
      cwd: "/tmp/project",
      codexSandbox: "workspace-write",
    });
    await waitForSpawnCalls(1);

    const [cmdAndArgs] = mockSpawn.mock.calls[0];
    // Sibling node exists, so it should use explicit node invocation
    expect(cmdAndArgs[0]).toBe(fakeNode);
    // The codex script path should be arg 1
    expect(cmdAndArgs[1]).toContain("codex");
    expect(cmdAndArgs).toContain("app-server");

    // Cleanup
    rmSync(tmpBinDir, { recursive: true, force: true });
  });

  it("does not invoke sibling node for a native codex binary", async () => {
    const tmpBinDir = mkdtempSync(join(tmpdir(), "codex-native-test-"));
    const fakeCodex = join(tmpBinDir, "codex");
    const fakeNode = join(tmpBinDir, "node");
    const { writeFileSync: realWriteFileSync } = require("node:fs");

    realWriteFileSync(fakeCodex, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00, 0x00, 0x01]));
    realWriteFileSync(fakeNode, "#!/bin/sh\n");

    mockResolveBinary.mockReturnValue(fakeCodex);
    mockSpawn.mockReturnValueOnce(createMockCodexProc());

    await launcher.launch({
      backendType: "codex",
      cwd: "/tmp/project",
      codexSandbox: "workspace-write",
    });
    await waitForSpawnCalls(1);

    const [cmdAndArgs] = mockSpawn.mock.calls[0];
    expect(cmdAndArgs[0]).toBe(fakeCodex);
    expect(cmdAndArgs[1]).toBe("-a");

    rmSync(tmpBinDir, { recursive: true, force: true });
  });

  it("sets state=exited and exitCode=127 when codex binary not found", async () => {
    mockResolveBinary.mockReturnValue(null);

    const info = await launcher.launch({
      backendType: "codex",
      cwd: "/tmp/project",
      codexSandbox: "workspace-write",
    });

    expect(info.state).toBe("exited");
    expect(info.exitCode).toBe(127);
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

// ─── state management ────────────────────────────────────────────────────────

describe("state management", () => {
  describe("markConnected", () => {
    it("sets state to connected", async () => {
      await launcher.launch({ cwd: "/tmp" });
      launcher.markConnected("test-session-id");

      const session = launcher.getSession("test-session-id");
      expect(session?.state).toBe("connected");
    });

    it("does nothing for unknown session", () => {
      // Should not throw
      launcher.markConnected("nonexistent");
    });
  });

  describe("setCLISessionId", () => {
    it("stores the CLI session ID", async () => {
      await launcher.launch({ cwd: "/tmp" });
      launcher.setCLISessionId("test-session-id", "cli-internal-abc");

      const session = launcher.getSession("test-session-id");
      expect(session?.cliSessionId).toBe("cli-internal-abc");
    });

    it("does nothing for unknown session", () => {
      // Should not throw
      launcher.setCLISessionId("nonexistent", "cli-id");
    });
  });

  describe("isAlive", () => {
    it("returns true for non-exited session", async () => {
      await launcher.launch({ cwd: "/tmp" });
      expect(launcher.isAlive("test-session-id")).toBe(true);
    });

    it("returns false for exited session", async () => {
      await launcher.launch({ cwd: "/tmp" });

      // Simulate process exit
      exitResolve(0);
      // Allow the .then callback in spawnCLI to run
      await new Promise((r) => setTimeout(r, 10));

      expect(launcher.isAlive("test-session-id")).toBe(false);
    });

    it("returns false for unknown session", () => {
      expect(launcher.isAlive("nonexistent")).toBe(false);
    });
  });

  describe("listSessions", () => {
    it("returns all sessions", async () => {
      // Because randomUUID is mocked to always return the same value,
      // we need to test with a single launch. But we can verify the list.
      await launcher.launch({ cwd: "/tmp" });
      const sessions = launcher.listSessions();

      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe("test-session-id");
    });

    it("returns empty array when no sessions exist", () => {
      expect(launcher.listSessions()).toEqual([]);
    });
  });

  describe("getSession", () => {
    it("returns a specific session", async () => {
      await launcher.launch({ cwd: "/tmp/myproject" });

      const session = launcher.getSession("test-session-id");
      expect(session).toBeDefined();
      expect(session?.cwd).toBe("/tmp/myproject");
    });

    it("returns undefined for unknown session", () => {
      expect(launcher.getSession("nonexistent")).toBeUndefined();
    });
  });

  describe("pruneExited", () => {
    it("removes exited sessions and returns count", async () => {
      await launcher.launch({ cwd: "/tmp" });

      // Simulate process exit
      exitResolve(0);
      await new Promise((r) => setTimeout(r, 10));

      expect(launcher.getSession("test-session-id")?.state).toBe("exited");

      const pruned = launcher.pruneExited();
      expect(pruned).toBe(1);
      expect(launcher.listSessions()).toHaveLength(0);
    });

    it("returns 0 when no sessions are exited", async () => {
      await launcher.launch({ cwd: "/tmp" });
      const pruned = launcher.pruneExited();
      expect(pruned).toBe(0);
      expect(launcher.listSessions()).toHaveLength(1);
    });
  });

  describe("setArchived", () => {
    it("sets the archived flag on a session", async () => {
      await launcher.launch({ cwd: "/tmp" });
      launcher.setArchived("test-session-id", true);

      const session = launcher.getSession("test-session-id");
      expect(session?.archived).toBe(true);
    });

    it("can unset the archived flag", async () => {
      await launcher.launch({ cwd: "/tmp" });
      launcher.setArchived("test-session-id", true);
      launcher.setArchived("test-session-id", false);

      const session = launcher.getSession("test-session-id");
      expect(session?.archived).toBe(false);
    });

    it("does nothing for unknown session", () => {
      // Should not throw
      launcher.setArchived("nonexistent", true);
    });
  });

  describe("removeSession", () => {
    it("deletes session from internal maps", async () => {
      await launcher.launch({ cwd: "/tmp" });
      expect(launcher.getSession("test-session-id")).toBeDefined();

      launcher.removeSession("test-session-id");
      expect(launcher.getSession("test-session-id")).toBeUndefined();
      expect(launcher.listSessions()).toHaveLength(0);
    });

    it("does nothing for unknown session", () => {
      // Should not throw
      launcher.removeSession("nonexistent");
    });
  });
});

// ─── kill ────────────────────────────────────────────────────────────────────

describe("kill", () => {
  it("sends SIGTERM via proc.kill", async () => {
    await launcher.launch({ cwd: "/tmp" });

    // Grab the mock proc
    const mockProc = mockSpawn.mock.results[0].value;

    // Resolve the exit promise so kill() doesn't wait on the timeout
    setTimeout(() => exitResolve(0), 5);

    const result = await launcher.kill("test-session-id");

    expect(result).toBe(true);
    expect(mockProc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("marks session as exited", async () => {
    await launcher.launch({ cwd: "/tmp" });

    setTimeout(() => exitResolve(0), 5);
    await launcher.kill("test-session-id");

    const session = launcher.getSession("test-session-id");
    expect(session?.state).toBe("exited");
    expect(session?.exitCode).toBe(-1);
  });

  it("returns false for unknown session", async () => {
    const result = await launcher.kill("nonexistent");
    expect(result).toBe(false);
  });
});

// ─── relaunch ────────────────────────────────────────────────────────────────

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
    expect(relaunchSysPrompt).toContain("Skeptic Review");
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
    expect(sysPrompt).not.toContain("Skeptic Review");
  });
});

// ─── session identity injection ──────────────────────────────────────────────

describe("session identity injection", () => {
  // q-197: Every session's system prompt should include its Takode session
  // number so the model can self-reference (e.g. "I am session #3").
  it("includes session number in the system prompt", async () => {
    await launcher.launch({ cwd: "/tmp/project" });

    const [cmdAndArgs] = mockSpawn.mock.calls[0];
    const sysPromptIdx = cmdAndArgs.indexOf("--append-system-prompt");
    expect(sysPromptIdx).toBeGreaterThan(-1);
    const sysPrompt = String(cmdAndArgs[sysPromptIdx + 1] ?? "");
    // Session number is assigned monotonically starting from 1
    expect(sysPrompt).toContain("You are Takode session #");
    expect(sysPrompt).toContain("earlier context from this same session");
    expect(sysPrompt).toContain("Start with `takode scan ");
    // Verify it appears before other sections (link syntax, timers, etc.)
    const identityIdx = sysPrompt.indexOf("You are Takode session #");
    const linkSyntaxIdx = sysPrompt.indexOf("Link Syntax");
    expect(identityIdx).toBeLessThan(linkSyntaxIdx);
  });

  it("documents the title plus description timer flow in the system prompt", async () => {
    // q-320: the injected timer instructions must match the current timer CLI
    // shape so sessions stop generating stale prompt-only timer commands.
    await launcher.launch({ cwd: "/tmp/project" });

    const [cmdAndArgs] = mockSpawn.mock.calls[0];
    const sysPromptIdx = cmdAndArgs.indexOf("--append-system-prompt");
    expect(sysPromptIdx).toBeGreaterThan(-1);
    const sysPrompt = String(cmdAndArgs[sysPromptIdx + 1] ?? "");

    expect(sysPrompt).toContain('takode timer create "Check build health" --desc');
    expect(sysPrompt).toContain("Keep timer titles concise and human-scannable.");
    expect(sysPrompt).toContain("For recurring timers, keep the description general");
    expect(sysPrompt).not.toContain("takode timer create <prompt>");
  });
});

// ─── persistence ─────────────────────────────────────────────────────────────

describe("persistence", () => {
  describe("restoreFromDisk", () => {
    it("recovers sessions from the store", async () => {
      // Manually write launcher data to disk to simulate a previous run
      const savedSessions = [
        {
          sessionId: "restored-1",
          pid: 99999,
          state: "connected" as const,
          cwd: "/tmp/project",
          createdAt: Date.now(),
          cliSessionId: "cli-abc",
        },
      ];
      store.saveLauncher(savedSessions);
      await store.flushAll();

      // Mock process.kill(pid, 0) to succeed (process is alive)
      const origKill = process.kill;
      const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
        if (signal === 0) return true;
        return origKill.call(process, pid, signal as any);
      }) as any);

      const newLauncher = new CliLauncher(3456, { serverId: "test-server-id" });
      newLauncher.setStore(store);
      const recovered = await newLauncher.restoreFromDisk();

      expect(recovered).toBe(1);

      const session = newLauncher.getSession("restored-1");
      expect(session).toBeDefined();
      // Live PIDs get state reset to "starting" awaiting WS reconnect
      expect(session?.state).toBe("starting");
      expect(session?.cliSessionId).toBe("cli-abc");

      killSpy.mockRestore();
    });

    it("marks dead PIDs as exited", async () => {
      const savedSessions = [
        {
          sessionId: "dead-1",
          pid: 11111,
          state: "connected" as const,
          cwd: "/tmp/project",
          createdAt: Date.now(),
        },
      ];
      store.saveLauncher(savedSessions);
      await store.flushAll();

      // Mock process.kill(pid, 0) to throw (process is dead)
      const killSpy = vi.spyOn(process, "kill").mockImplementation(((_pid: number, signal?: string | number) => {
        if (signal === 0) throw new Error("ESRCH");
        return true;
      }) as any);

      const newLauncher = new CliLauncher(3456, { serverId: "test-server-id" });
      newLauncher.setStore(store);
      const recovered = await newLauncher.restoreFromDisk();

      // Dead sessions don't count as recovered
      expect(recovered).toBe(0);

      const session = newLauncher.getSession("dead-1");
      expect(session).toBeDefined();
      expect(session?.state).toBe("exited");
      expect(session?.exitCode).toBe(-1);

      killSpy.mockRestore();
    });

    it("returns 0 when no store is set", async () => {
      const newLauncher = new CliLauncher(3456, { serverId: "test-server-id" });
      // No setStore call
      expect(await newLauncher.restoreFromDisk()).toBe(0);
    });

    it("returns 0 when store has no launcher data", async () => {
      const newLauncher = new CliLauncher(3456, { serverId: "test-server-id" });
      newLauncher.setStore(store);
      // Store is empty, no launcher.json file
      expect(await newLauncher.restoreFromDisk()).toBe(0);
    });

    it("preserves already-exited sessions from disk", async () => {
      const savedSessions = [
        {
          sessionId: "already-exited",
          pid: 22222,
          state: "exited" as const,
          exitCode: 0,
          cwd: "/tmp/project",
          createdAt: Date.now(),
        },
      ];
      store.saveLauncher(savedSessions);
      await store.flushAll();

      const newLauncher = new CliLauncher(3456, { serverId: "test-server-id" });
      newLauncher.setStore(store);
      const recovered = await newLauncher.restoreFromDisk();

      // Already-exited sessions are loaded but not "recovered"
      expect(recovered).toBe(0);
      const session = newLauncher.getSession("already-exited");
      expect(session).toBeDefined();
      expect(session?.state).toBe("exited");
    });

    it("marks SDK sessions without PID as exited for auto-relaunch", async () => {
      const savedSessions = [
        {
          sessionId: "sdk-session-1",
          // No pid — SDK sessions use in-memory adapters, not processes
          state: "connected" as const,
          backendType: "claude-sdk" as const,
          cwd: "/tmp/project",
          createdAt: Date.now(),
          cliSessionId: "sdk-cli-123",
        },
      ];
      store.saveLauncher(savedSessions);
      await store.flushAll();

      const newLauncher = new CliLauncher(3456, { serverId: "test-server-id" });
      newLauncher.setStore(store);
      const recovered = await newLauncher.restoreFromDisk();

      // SDK sessions are not "recovered" (no live process) but are marked exited
      // so handleBrowserOpen will trigger relaunch instead of optimistically
      // sending backend_connected.
      expect(recovered).toBe(0);

      const session = newLauncher.getSession("sdk-session-1");
      expect(session).toBeDefined();
      expect(session?.state).toBe("exited");
      expect(session?.exitCode).toBe(-1);
      // cliSessionId is preserved for --resume via SDK's resumeSession
      expect(session?.cliSessionId).toBe("sdk-cli-123");
    });

    it("does not re-mark already-exited SDK sessions", async () => {
      const savedSessions = [
        {
          sessionId: "sdk-already-exited",
          state: "exited" as const,
          exitCode: 0,
          backendType: "claude-sdk" as const,
          cwd: "/tmp/project",
          createdAt: Date.now(),
        },
      ];
      store.saveLauncher(savedSessions);
      await store.flushAll();

      const newLauncher = new CliLauncher(3456, { serverId: "test-server-id" });
      newLauncher.setStore(store);
      const recovered = await newLauncher.restoreFromDisk();

      expect(recovered).toBe(0);
      const session = newLauncher.getSession("sdk-already-exited");
      expect(session).toBeDefined();
      expect(session?.state).toBe("exited");
      // exitCode should remain as originally set (0), not overwritten to -1
      expect(session?.exitCode).toBe(0);
    });
  });
});

describe("getStartingSessions", () => {
  it("returns only sessions in starting state", async () => {
    await launcher.launch({ cwd: "/tmp" });

    const starting = launcher.getStartingSessions();
    expect(starting).toHaveLength(1);
    expect(starting[0].state).toBe("starting");
  });

  it("excludes sessions that have been connected", async () => {
    await launcher.launch({ cwd: "/tmp" });
    launcher.markConnected("test-session-id");

    const starting = launcher.getStartingSessions();
    expect(starting).toHaveLength(0);
  });

  it("returns empty array when no sessions exist", () => {
    expect(launcher.getStartingSessions()).toEqual([]);
  });
});

// ─── symlinkProjectSettings (via worktree launch) ─────────────────────────

describe("symlinkProjectSettings", () => {
  // Helper to launch a worktree session that triggers injectWorktreeGuardrails
  // → symlinkProjectSettings. The mock for existsSync must return true for the
  // worktree path (guard at line 837) and handle settings file checks.
  const WORKTREE = "/tmp/worktrees/my-project";
  const REPO_ROOT = "/tmp/main-repo/my-project";

  async function launchWorktree(existsSyncImpl?: (path: string) => boolean) {
    // Default: worktree dir exists, no settings files present yet
    mockExistsSync.mockImplementation((path: string) => {
      if (path === WORKTREE) return true; // worktree dir must exist
      if (existsSyncImpl) return existsSyncImpl(path);
      return false; // no CLAUDE.md, no settings files
    });
    await launcher.launch({
      cwd: WORKTREE,
      worktreeInfo: {
        isWorktree: true,
        repoRoot: REPO_ROOT,
        branch: "feature-x",
        actualBranch: "feature-x",
        worktreePath: WORKTREE,
      },
    });
  }

  it("creates symlinks for settings.json and settings.local.json when they don't exist", async () => {
    await launchWorktree();

    // Both settings files should be symlinked to the main repo
    expect(mockSymlinkSync).toHaveBeenCalledTimes(2);
    expect(mockSymlinkSync).toHaveBeenCalledWith(
      join(REPO_ROOT, ".claude", "settings.json"),
      join(WORKTREE, ".claude", "settings.json"),
    );
    expect(mockSymlinkSync).toHaveBeenCalledWith(
      join(REPO_ROOT, ".claude", "settings.local.json"),
      join(WORKTREE, ".claude", "settings.local.json"),
    );
  });

  it("ensures the main repo .claude directory exists", async () => {
    await launchWorktree();

    // mkdir should be called for the repo's .claude dir (recursive)
    expect(mockMkdirSync).toHaveBeenCalledWith(join(REPO_ROOT, ".claude"), { recursive: true });
  });

  it("merges a real (non-symlink) file into repo and replaces with symlink", async () => {
    // Simulate settings.json being a real file in the worktree (Claude Code's
    // atomic write broke a previous symlink). The file should be merged into
    // the main repo's copy and replaced with a symlink.
    mockLstatSync.mockImplementation((path: any) => {
      if (path === join(WORKTREE, ".claude", "settings.json")) {
        return { isSymbolicLink: () => false };
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    mockExistsSync.mockImplementation((path: string) => {
      if (path === WORKTREE) return true;
      // Repo target file exists (seeded or from previous worktree)
      if (path === join(REPO_ROOT, ".claude", "settings.json")) return true;
      return false;
    });
    // Mock readFileSync for merge — worktree file has rules, repo file is empty
    mockReadFileSync.mockImplementation((path: any) => {
      if (path === join(WORKTREE, ".claude", "settings.json")) {
        return JSON.stringify({ permissions: { allow: ["Bash(git reset:*)"] } });
      }
      if (path === join(REPO_ROOT, ".claude", "settings.json")) {
        return "{}";
      }
      return "";
    });

    await launcher.launch({
      cwd: WORKTREE,
      worktreeInfo: {
        isWorktree: true,
        repoRoot: REPO_ROOT,
        branch: "feature-x",
        actualBranch: "feature-x",
        worktreePath: WORKTREE,
      },
    });

    // Real file should be removed and replaced with symlink
    expect(mockUnlinkSync).toHaveBeenCalledWith(join(WORKTREE, ".claude", "settings.json"));
    // Both settings.json and settings.local.json should be symlinked
    expect(mockSymlinkSync).toHaveBeenCalledTimes(2);
    expect(mockSymlinkSync).toHaveBeenCalledWith(
      join(REPO_ROOT, ".claude", "settings.json"),
      join(WORKTREE, ".claude", "settings.json"),
    );
    // Repo file should be written with merged permissions
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      join(REPO_ROOT, ".claude", "settings.json"),
      expect.stringContaining("git reset"),
      "utf-8",
    );
  });

  it("leaves an existing symlink alone (idempotent)", async () => {
    // Both files exist and are already symlinks
    mockExistsSync.mockImplementation((path: string) => {
      if (path === WORKTREE) return true;
      if (path === join(WORKTREE, ".claude", "settings.json")) return true;
      if (path === join(WORKTREE, ".claude", "settings.local.json")) return true;
      return false;
    });
    mockLstatSync.mockReturnValue({ isSymbolicLink: () => true });

    await launcher.launch({
      cwd: WORKTREE,
      worktreeInfo: {
        isWorktree: true,
        repoRoot: REPO_ROOT,
        branch: "feature-x",
        actualBranch: "feature-x",
        worktreePath: WORKTREE,
      },
    });

    // Already symlinks — should not create new ones
    expect(mockSymlinkSync).not.toHaveBeenCalled();
  });

  it("skips symlink creation when repoRoot is empty", async () => {
    mockExistsSync.mockImplementation((path: string) => {
      if (path === WORKTREE) return true;
      return false;
    });

    await launcher.launch({
      cwd: WORKTREE,
      worktreeInfo: {
        isWorktree: true,
        repoRoot: "", // empty repoRoot
        branch: "feature-x",
        actualBranch: "feature-x",
        worktreePath: WORKTREE,
      },
    });

    expect(mockSymlinkSync).not.toHaveBeenCalled();
  });

  it("adds git exclude entries when .git file is present", async () => {
    // Simulate the worktree having a .git file (standard for worktrees) that
    // points to a gitdir. addWorktreeGitExclude reads it to find info/exclude.
    const gitDir = "/tmp/worktrees/.git-worktree-dir";
    mockExistsSync.mockImplementation((path: string) => {
      if (path === WORKTREE) return true;
      // .git file exists (a file, not dir, as in worktrees)
      if (path === join(WORKTREE, ".git")) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === join(WORKTREE, ".git")) return `gitdir: ${gitDir}`;
      return "";
    });

    await launcher.launch({
      cwd: WORKTREE,
      worktreeInfo: {
        isWorktree: true,
        repoRoot: REPO_ROOT,
        branch: "feature-x",
        actualBranch: "feature-x",
        worktreePath: WORKTREE,
      },
    });

    // Verify symlinks were created
    expect(mockSymlinkSync).toHaveBeenCalledTimes(2);

    // Verify git exclude was written for the settings symlinks
    const writeFileCalls = mockWriteFileSync.mock.calls.map((c: any[]) => c[0]);
    const excludeCalls = writeFileCalls.filter((p: string) => typeof p === "string" && p.includes("info/exclude"));
    // CLAUDE.md + settings.json + settings.local.json = 3 exclude entries
    expect(excludeCalls.length).toBeGreaterThanOrEqual(2);
  });

  // NOTE: Tests for CLAUDE.md/AGENTS.md file injection were removed because
  // worktree instructions now go through the system prompt (--append-system-prompt
  // for Claude, developer_instructions for Codex, appendSystemPrompt for SDK)
  // instead of file-based injection. See q-124.

  it("removes stale .claude/CLAUDE.md containing old guardrails markers on launch", async () => {
    // Older code wrote guardrails between WORKTREE_GUARDRAILS_START/END markers.
    // These files persist across sessions with wrong branch names and repo paths.
    // The cleanup in injectWorktreeGuardrails should delete the file when it
    // contains only the old guardrails block.
    const staleContent =
      "<!-- WORKTREE_GUARDRAILS_START -->\n" +
      "# Worktree Session — Branch Guardrails\n" +
      "You are on branch: `old-branch`\n" +
      "<!-- WORKTREE_GUARDRAILS_END -->";
    const claudeMdPath = join(WORKTREE, ".claude", "CLAUDE.md");

    mockExistsSync.mockImplementation((path: string) => {
      if (path === WORKTREE) return true;
      if (path === claudeMdPath) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === claudeMdPath) return staleContent;
      return "";
    });

    await launcher.launch({
      cwd: WORKTREE,
      worktreeInfo: {
        isWorktree: true,
        repoRoot: REPO_ROOT,
        branch: "feature-x",
        actualBranch: "feature-x",
        worktreePath: WORKTREE,
      },
    });

    // File contained only guardrails — should be deleted entirely
    expect(mockUnlinkSync).toHaveBeenCalledWith(claudeMdPath);
  });

  it("strips guardrails block but preserves other content in .claude/CLAUDE.md", async () => {
    // When .claude/CLAUDE.md has user content alongside the old guardrails
    // markers, only the guardrails block should be removed.
    const userContent = "# My Project Notes\n\nSome important notes here.";
    const staleContent =
      "<!-- WORKTREE_GUARDRAILS_START -->\n" +
      "# Worktree Session — Branch Guardrails\n" +
      "You are on branch: `old-branch`\n" +
      "<!-- WORKTREE_GUARDRAILS_END -->\n" +
      userContent;
    const claudeMdPath = join(WORKTREE, ".claude", "CLAUDE.md");

    mockExistsSync.mockImplementation((path: string) => {
      if (path === WORKTREE) return true;
      if (path === claudeMdPath) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === claudeMdPath) return staleContent;
      return "";
    });

    await launcher.launch({
      cwd: WORKTREE,
      worktreeInfo: {
        isWorktree: true,
        repoRoot: REPO_ROOT,
        branch: "feature-x",
        actualBranch: "feature-x",
        worktreePath: WORKTREE,
      },
    });

    // File had other content — should be rewritten without the guardrails block
    expect(mockUnlinkSync).not.toHaveBeenCalledWith(claudeMdPath);
    expect(mockWriteFileSync).toHaveBeenCalledWith(claudeMdPath, userContent + "\n", "utf-8");
  });

  it("leaves .claude/CLAUDE.md alone when no guardrails markers are present", async () => {
    // Files without the old markers should not be touched at all.
    const normalContent = "# My Project\n\nJust some project instructions.";
    const claudeMdPath = join(WORKTREE, ".claude", "CLAUDE.md");

    mockExistsSync.mockImplementation((path: string) => {
      if (path === WORKTREE) return true;
      if (path === claudeMdPath) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === claudeMdPath) return normalContent;
      return "";
    });

    await launcher.launch({
      cwd: WORKTREE,
      worktreeInfo: {
        isWorktree: true,
        repoRoot: REPO_ROOT,
        branch: "feature-x",
        actualBranch: "feature-x",
        worktreePath: WORKTREE,
      },
    });

    // No markers found — file should not be modified or deleted
    expect(mockUnlinkSync).not.toHaveBeenCalledWith(claudeMdPath);
    // writeFile may be called for other reasons (settings), but not for CLAUDE.md
    const claudeMdWrites = mockWriteFileSync.mock.calls.filter((c: any[]) => c[0] === claudeMdPath);
    expect(claudeMdWrites).toHaveLength(0);
  });

  it("injects worktree porting reference into the Claude system prompt", async () => {
    await launchWorktree();

    const [cmdAndArgs] = mockSpawn.mock.calls[0];
    const promptIdx = cmdAndArgs.indexOf("--append-system-prompt");
    expect(promptIdx).toBeGreaterThan(-1);
    const prompt = String(cmdAndArgs[promptIdx + 1] ?? "");
    // Porting instructions now reference the /port-changes skill instead of inline content
    expect(prompt).toContain("/port-changes");
    expect(prompt).toContain("Base repo checkout");
    expect(prompt).toContain("Base branch");
    expect(prompt).toContain("override any conflicting generic markdown-link or file-reference instructions");
    expect(prompt).toContain("never write plain");
    expect(prompt).toContain("Even if the user refers to quests or sessions in plain text");
    expect(prompt).toContain("rich links in the chat UI");
    expect(prompt).toContain("hover for previews and click through");
  });
});

describe("getOrchestratorGuardrails", () => {
  it("returns Claude-family guardrails with skill loading and sub-skill references", () => {
    // getOrchestratorGuardrails returns a trimmed system prompt that references
    // sub-skill files for detailed workflows. Detailed content (worker selection
    // rules, full quest journey transitions, CLI docs) lives in sub-skill .md files.
    const guardrails = launcher.getOrchestratorGuardrails("claude");
    expect(guardrails).toContain("Takode -- Cross-Session Orchestration");
    // CLI, quest, and leader-dispatch references point to skills loaded on startup
    expect(guardrails).toContain("takode-orchestration");
    expect(guardrails).toContain("leader-dispatch");
    expect(guardrails).toContain("quest");
    expect(guardrails).toContain("sub-agent");
    // Core leader behaviors remain inline
    expect(guardrails).toContain("Create a quest for any non-trivial work");
    expect(guardrails).toContain("Never implement non-trivial changes yourself");
    // Quest Journey stage table kept inline as quick reference
    expect(guardrails).toContain("Quest Journey");
    expect(guardrails).toContain("QUEUED");
    expect(guardrails).toContain("IMPLEMENTING");
    expect(guardrails).toContain("Skeptic Review");
    expect(guardrails).toContain("Work Board");
    // Spawn backend default note
    expect(guardrails).toContain("default to your own backend type");
    // Skill references: /leader-dispatch for dispatch workflow, sub-files for quest-journey and board-usage
    expect(guardrails).toContain("/leader-dispatch");
    expect(guardrails).toContain("quest-journey.md");
    expect(guardrails).toContain("board-usage.md");
    // Leader discipline: wait for user answer, no skipping stages
    expect(guardrails).toContain("WAIT for their answer");
    expect(guardrails).toContain("Never skip quest journey stages");
    expect(guardrails).toContain("Do not use sleep-based waits");
    expect(guardrails).toContain("repeated `takode peek` / `takode scan` checks");
    expect(guardrails).toContain("wait for the next herd event");
    expect(guardrails).toContain("Only inspect a worker after a herd event");
    expect(guardrails).toContain(
      "prefer the plain-text forms of `takode info`, `takode peek`, `takode scan`, and `quest show`",
    );
    expect(guardrails).toContain("Use `--json` only when you need exact structured fields");
    expect(guardrails).toContain("feedback `addressed` flags");
    expect(guardrails).toContain("`commitShas`");
    expect(guardrails).toContain("Make every worker instruction stage-explicit");
    expect(guardrails).toContain("Initial dispatch authorizes **planning only**");
    expect(guardrails).toContain("Leaders do not own worker quests");
    expect(guardrails).toContain("worker doing the job claims and completes the quest");
    expect(guardrails).toContain("Archiving a worktree worker removes its worktree and any uncommitted changes");
    expect(guardrails).toContain("ported, committed, or otherwise synced");
    expect(guardrails).toContain("implement, update the quest summary comment, and stop when done");
    expect(guardrails).toContain("Do **not** tell the worker to port yet");
    expect(guardrails).toContain("investigation, design, or other no-code quests");
    expect(guardrails).toContain("address reviewer-groom findings, update the quest summary comment, and stop");
    expect(guardrails).toContain("what artifact to produce and to stop afterward");
    expect(guardrails).toContain("send a separate explicit port instruction when ready");
    expect(guardrails).toContain("prefer `quest grep <pattern>` over manually scanning many `quest show` results");
    expect(guardrails).toContain("Use `quest list --text` for broad list filtering and `quest grep`");
    expect(guardrails).toContain("takode notify");
    expect(guardrails).toContain("needs-input");
    expect(guardrails).toContain("review");
    expect(guardrails).toContain("Every time you ask the user a question");
    expect(guardrails).toContain("also call `takode notify needs-input`");
    expect(guardrails).toContain("so the user never misses the leader's question");
    expect(guardrails).toContain("Do **not** call `takode notify review` for quest completion");
    expect(guardrails).toContain("Takode already sends that review notification automatically");
    // Detailed content moved to sub-skill files, not inline
    expect(guardrails).not.toContain("takode list [--active] [--all]");
    expect(guardrails).not.toContain("takode peek <session> [--from N]");
    expect(guardrails).not.toContain("Maintain at most 5 sessions");
    // Worker selection details now in /leader-dispatch skill
    expect(guardrails).not.toContain("Queue if the best worker is busy");
    // Full stage transitions now in quest-journey.md
    expect(guardrails).not.toContain("QUEUED -> PLANNING");
  });

  it("returns Codex guardrails without Claude-only or sub-agent guidance", () => {
    const guardrails = launcher.getOrchestratorGuardrails("codex");
    expect(guardrails).toContain("leader session");
    expect(guardrails).toContain("Delegate all major work");
    // Skill references for detailed workflows
    expect(guardrails).toContain("/leader-dispatch");
    expect(guardrails).toContain("quest-journey.md");
    // Quest Journey stage table inline as quick reference
    expect(guardrails).toContain("Quest Journey");
    expect(guardrails).toContain("Skeptic Review");
    // CLI reference delegated to skill
    expect(guardrails).toContain("takode-orchestration");
    expect(guardrails).toContain("default to your own backend type");
    expect(guardrails).toContain("Do not use sleep-based waits");
    expect(guardrails).toContain("wait for the next herd event");
    expect(guardrails).toContain("Make every worker instruction stage-explicit");
    expect(guardrails).toContain("Initial dispatch authorizes **planning only**");
    expect(guardrails).toContain("Leaders do not own worker quests");
    expect(guardrails).toContain("worker doing the job claims and completes the quest");
    expect(guardrails).toContain("Archiving a worktree worker removes its worktree and any uncommitted changes");
    expect(guardrails).toContain("ported, committed, or otherwise synced");
    expect(guardrails).toContain("implement, update the quest summary comment, and stop when done");
    expect(guardrails).toContain("Do **not** tell the worker to port yet");
    expect(guardrails).toContain("address reviewer-groom findings, update the quest summary comment, and stop");
    expect(guardrails).toContain("what artifact to produce and to stop afterward");
    expect(guardrails).toContain("send a separate explicit port instruction when ready");
    expect(guardrails).toContain("Every time you ask the user a question");
    expect(guardrails).toContain("also call `takode notify needs-input`");
    expect(guardrails).toContain("so the user never misses the leader's question");
    expect(guardrails).toContain("Do **not** call `takode notify review` for quest completion");
    expect(guardrails).toContain("Takode already sends that review notification automatically");
    // No verbose CLI command docs
    expect(guardrails).not.toContain("takode list [--active] [--all]");
    expect(guardrails).not.toContain("CLAUDE.md");
    expect(guardrails).not.toContain("sub-agent");
    expect(guardrails).not.toMatch(/\bagent\b/i);
  });
});

// ─── Cat herding (orchestrator→worker relationships) ────────────────────────

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
        getSessionMessages: vi.fn(() => null),
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
          onHerdMembershipChanged: vi.fn(),
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

      expect(bridge.injectUserMessage).toHaveBeenCalledWith("orch-1", expect.stringContaining("herd_reassigned"), {
        sessionId: "herd-events",
        sessionLabel: "Herd Events",
      });

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
});
