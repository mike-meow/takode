import { vi } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir, hostname, tmpdir } from "node:os";

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
    path.includes(".agents") ||
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
const mockRm = vi.hoisted(() =>
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
    rm: async (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockRm(...args);
      }
      return actual.rm(...args);
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
import { CliLauncher, type LaunchOptions } from "./cli-launcher.js";
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
  let exited = false;
  const exitedPromise = new Promise<number>((r) => {
    resolve = r;
  });
  const resolveExit = (code: number) => {
    if (exited) return;
    exited = true;
    resolve(code);
  };
  exitResolve = resolveExit;
  return {
    pid,
    kill: vi.fn((signal?: string) => {
      resolveExit(signal === "SIGKILL" ? 137 : 0);
    }),
    exited: exitedPromise,
    stdin: new WritableStream<Uint8Array>(),
    stdout: new ReadableStream<Uint8Array>(),
    stderr: new ReadableStream<Uint8Array>(),
  };
}

function createMaiWrapperFixture(options?: { envHost?: string; hostCodexHome?: string }) {
  const root = mkdtempSync(join(tmpdir(), "mai-wrapper-test-"));
  const envHost =
    options?.envHost ||
    hostname()
      .replace(/[^A-Za-z0-9._-]/g, "-")
      .replace(/^[._-]+/, "")
      .replace(/[._-]+$/, "")
      .slice(0, 64)
      .replace(/[._-]+$/, "") ||
    "host";
  const hostCodexHome = options?.hostCodexHome || "/Users/test/.codex/hosts/test-host";
  mkdirSync(join(root, ".run"), { recursive: true });
  writeFileSync(join(root, ".mai-agents-root"), "");
  writeFileSync(
    join(root, ".run", `.env-${envHost}`),
    [
      'LITELLM_API_KEY="sk-wrapper123"',
      'LITELLM_PROXY_URL="http://localhost:4000"',
      `CODEX_HOME="${hostCodexHome}"`,
      "",
    ].join("\n"),
  );
  const wrapperPath = join(root, "codex.sh");
  writeFileSync(wrapperPath, ["#!/usr/bin/env bash", "set -euo pipefail", 'echo "wrapper placeholder"', ""].join("\n"));
  chmodSync(wrapperPath, 0o755);
  return { root, wrapperPath };
}

function normalizeMaiHostname(input: string): string {
  let normalized = input.replace(/[^A-Za-z0-9._-]/g, "-");
  while (normalized.length > 0 && /^[._-]/.test(normalized)) normalized = normalized.slice(1);
  while (normalized.length > 0 && /[._-]$/.test(normalized)) normalized = normalized.slice(0, -1);
  if (normalized.length > 64) {
    normalized = normalized.slice(0, 64);
    while (normalized.length > 0 && /[._-]$/.test(normalized)) normalized = normalized.slice(0, -1);
  }
  return normalized || "host";
}

function getMaiWrapperSessionEnvPath(wrapperRoot: string, sessionId = "test-session-id") {
  const overlayHost = normalizeMaiHostname(`companion-codex-home-${sessionId}`);
  return join(wrapperRoot, ".run", `.env-${overlayHost}`);
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
  const launchCodex = async (overrides: LaunchOptions = {}, spawnCalls = 1) => {
    const info = await launcher.launch({
      backendType: "codex",
      cwd: "/tmp/project",
      codexSandbox: "workspace-write",
      ...overrides,
    });
    await waitForSpawnCalls(spawnCalls);
    return info;
  };
  const mockExistingPaths = (...paths: string[]) => {
    const existing = new Set(paths);
    mockExistsSync.mockImplementation((path: string) => existing.has(path));
  };
  const mockDirent = (name: string, options: { symlink?: boolean; directory?: boolean } = {}) => ({
    name,
    isSymbolicLink: () => options.symlink ?? false,
    isDirectory: () => options.directory ?? true,
  });

  it("writes session-auth to centralized ~/.companion/session-auth/ directory", async () => {
    mockResolveBinary.mockReturnValue("/opt/fake/codex");
    mockSpawn.mockReturnValueOnce(createMockCodexProc());
    await launchCodex({ codexSandbox: undefined });

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

    await launchCodex();
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

  it("disables Codex native image generation for mai-litellm session configs", async () => {
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
      ['model_provider = "mai-litellm"', "", "[features]", "image_generation = true", ""].join("\n"),
      "utf-8",
    );

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
      expect(updatedConfig).toContain("image_generation = false");
      expect(updatedConfig).not.toContain("image_generation = true");
    } finally {
      rmSync(customHome, { recursive: true, force: true });
    }
  });

  it("keeps Codex native image generation enabled for non-MAI providers", async () => {
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
    realWriteFileSync(configPath, ['model_provider = "openai"', ""].join("\n"), "utf-8");

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
      expect(updatedConfig).not.toContain("image_generation = false");
    } finally {
      rmSync(customHome, { recursive: true, force: true });
    }
  });

  it("applies the context-window override only to Codex leaders", async () => {
    mockResolveBinary.mockReturnValue("/opt/fake/codex");
    const customHome = mkdtempSync(join(tmpdir(), "codex-home-test-"));
    const sessionHome = join(customHome, "test-session-id");
    const configPath = join(sessionHome, "config.toml");
    const { readFileSync: realReadFileSync } = require("node:fs");

    try {
      mockSpawn.mockReturnValueOnce(createMockCodexProc());
      const workerInfo = await launcher.launch({
        backendType: "codex",
        cwd: "/tmp/project",
        codexSandbox: "workspace-write",
        codexHome: customHome,
        codexLeaderContextWindowOverrideTokens: 1_000_000,
      });
      await waitForSpawnCalls(1);

      let config = realReadFileSync(configPath, "utf-8");
      expect(config).not.toContain("model_context_window = 1000000");
      expect(config).not.toContain("model_auto_compact_token_limit = 1000000");

      (launcher.getSession(workerInfo.sessionId) as any).isOrchestrator = true;
      launcher.setSettingsGetter(() => ({
        claudeBinary: "",
        codexBinary: "/opt/fake/codex",
        codexLeaderContextWindowOverrideTokens: 1_000_000,
      }));
      mockSpawn.mockReturnValueOnce(createMockCodexProc(12346));
      const relaunch = await launcher.relaunch(workerInfo.sessionId);
      expect(relaunch.ok).toBe(true);
      await waitForSpawnCalls(2);

      config = realReadFileSync(configPath, "utf-8");
      expect(config).toContain("model_context_window = 1000000");
      expect(config).toContain("model_auto_compact_token_limit = 1000000");
    } finally {
      rmSync(customHome, { recursive: true, force: true });
    }
  });

  it("writes a session-local auto-compact model catalog override for non-leader Codex sessions", async () => {
    mockResolveBinary.mockReturnValue("/opt/fake/codex");
    mockSpawn.mockReturnValueOnce(createMockCodexProc());

    const customHome = mkdtempSync(join(tmpdir(), "codex-home-test-"));
    const sessionHome = join(customHome, "test-session-id");
    const configPath = join(sessionHome, "config.toml");
    const catalogSourcePath = join(sessionHome, "models_cache.json");
    const catalogPath = join(sessionHome, "takode-model-catalog.json");
    const {
      mkdirSync: realMkdirSync,
      writeFileSync: realWriteFileSync,
      readFileSync: realReadFileSync,
    } = require("node:fs");

    realMkdirSync(sessionHome, { recursive: true });
    realWriteFileSync(configPath, ['model = "gpt-5.5"', ""].join("\n"), "utf-8");
    realWriteFileSync(
      catalogSourcePath,
      JSON.stringify(
        {
          models: [
            {
              slug: "gpt-5.5",
              display_name: "GPT-5.5",
              context_window: 272000,
              max_context_window: 272000,
              effective_context_window_percent: 95,
              auto_compact_token_limit: null,
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    try {
      await launcher.launch({
        backendType: "codex",
        cwd: "/tmp/project",
        codexSandbox: "workspace-write",
        codexHome: customHome,
        codexNonLeaderAutoCompactThresholdPercent: 90,
      });
      await waitForSpawnCalls(1);

      const config = realReadFileSync(configPath, "utf-8");
      expect(config).toContain(`model_catalog_json = ${JSON.stringify(catalogPath)}`);

      const catalog = JSON.parse(realReadFileSync(catalogPath, "utf-8"));
      expect(catalog.models).toEqual([
        {
          slug: "gpt-5.5",
          display_name: "GPT-5.5",
          context_window: 272000,
          max_context_window: 272000,
          effective_context_window_percent: 95,
          auto_compact_token_limit: 232560,
        },
      ]);
    } finally {
      rmSync(customHome, { recursive: true, force: true });
    }
  });

  it("relaunches MAI-wrapper-backed Codex leaders with the session-local CODEX_HOME", async () => {
    const customHome = mkdtempSync(join(tmpdir(), "codex-home-test-"));
    const sessionHome = join(customHome, "test-session-id");
    const configPath = join(sessionHome, "config.toml");
    const shimDir = join(sessionHome, ".mai-wrapper-bin");
    const { readFileSync: realReadFileSync } = require("node:fs");
    const { root, wrapperPath } = createMaiWrapperFixture();

    try {
      mockResolveBinary.mockImplementation((name: string): string | null => {
        if (name === wrapperPath) return wrapperPath;
        if (name === "codex") return "/opt/fake/codex";
        return "/usr/bin/claude";
      });
      mockCaptureUserShellEnv.mockReturnValue({});

      mockSpawn.mockReturnValueOnce(createMockCodexProc());
      const workerInfo = await launcher.launch({
        backendType: "codex",
        cwd: "/tmp/project",
        codexSandbox: "workspace-write",
        codexBinary: wrapperPath,
        codexHome: customHome,
        codexLeaderContextWindowOverrideTokens: 1_000_000,
      });
      await waitForSpawnCalls(1);

      let [cmdAndArgs] = mockSpawn.mock.calls[0]!;
      expect(cmdAndArgs[0]).toBe(wrapperPath);

      (launcher.getSession(workerInfo.sessionId) as any).isOrchestrator = true;
      launcher.setSettingsGetter(() => ({
        claudeBinary: "",
        codexBinary: wrapperPath,
        codexLeaderContextWindowOverrideTokens: 1_000_000,
      }));
      mockSpawn.mockReturnValueOnce(createMockCodexProc(12346));
      const relaunch = await launcher.relaunch(workerInfo.sessionId);
      expect(relaunch.ok).toBe(true);
      await waitForSpawnCalls(2);

      [cmdAndArgs] = mockSpawn.mock.calls[1]!;
      const [, options] = mockSpawn.mock.calls[1]!;
      expect(cmdAndArgs[0]).toBe(wrapperPath);
      expect(options.env.CODEX_HOME).toBe(sessionHome);
      expect(options.env.PATH.split(":")[0]).toBe(shimDir);

      const wrapperEnv = realReadFileSync(getMaiWrapperSessionEnvPath(root), "utf-8");
      expect(wrapperEnv).toContain('LITELLM_PROXY_URL="http://localhost:4000"');
      expect(wrapperEnv).toContain(`CODEX_HOME='${sessionHome}'`);

      const config = realReadFileSync(configPath, "utf-8");
      expect(config).toContain("model_context_window = 1000000");
      expect(config).toContain("model_auto_compact_token_limit = 1000000");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(customHome, { recursive: true, force: true });
    }
  });

  it("launches MAI-wrapper-backed Codex leaders directly with the session-local CODEX_HOME", async () => {
    const customHome = mkdtempSync(join(tmpdir(), "codex-home-test-"));
    const sessionHome = join(customHome, "test-session-id");
    const configPath = join(sessionHome, "config.toml");
    const shimDir = join(sessionHome, ".mai-wrapper-bin");
    const { readFileSync: realReadFileSync } = require("node:fs");
    const { root, wrapperPath } = createMaiWrapperFixture();

    try {
      mockResolveBinary.mockImplementation((name: string): string | null => {
        if (name === wrapperPath) return wrapperPath;
        return "/usr/bin/claude";
      });
      mockCaptureUserShellEnv.mockReturnValue({});
      mockSpawn.mockReturnValueOnce(createMockCodexProc());

      await launcher.launch({
        backendType: "codex",
        cwd: "/tmp/project",
        codexSandbox: "workspace-write",
        codexBinary: wrapperPath,
        codexHome: customHome,
        codexLeaderContextWindowOverrideTokens: 1_000_000,
        env: {
          TAKODE_ROLE: "orchestrator",
          TAKODE_API_PORT: "3457",
        },
      });
      await waitForSpawnCalls(1);

      const [cmdAndArgs, options] = mockSpawn.mock.calls[0]!;
      expect(cmdAndArgs[0]).toBe(wrapperPath);
      expect(options.env.CODEX_HOME).toBe(sessionHome);
      expect(options.env.PATH.split(":")[0]).toBe(shimDir);

      const wrapperEnv = realReadFileSync(getMaiWrapperSessionEnvPath(root), "utf-8");
      expect(wrapperEnv).toContain('LITELLM_API_KEY="sk-wrapper123"');
      expect(wrapperEnv).toContain(`CODEX_HOME='${sessionHome}'`);

      const config = realReadFileSync(configPath, "utf-8");
      expect(config).toContain("model_context_window = 1000000");
      expect(config).toContain("model_auto_compact_token_limit = 1000000");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(customHome, { recursive: true, force: true });
    }
  });

  it("writes a session-local model catalog override for MAI-wrapper-backed Codex leaders", async () => {
    const customHome = mkdtempSync(join(tmpdir(), "codex-home-test-"));
    const hostCodexHome = mkdtempSync(join(tmpdir(), "codex-host-home-test-"));
    const sessionHome = join(customHome, "test-session-id");
    const configPath = join(sessionHome, "config.toml");
    const catalogPath = join(sessionHome, "takode-leader-model-catalog.json");
    const { root, wrapperPath } = createMaiWrapperFixture({ hostCodexHome });
    const { readFileSync: realReadFileSync } = require("node:fs");

    try {
      writeFileSync(
        join(hostCodexHome, "config.toml"),
        ['model = "gpt-5.5"', "model_context_window = 1000000", "model_auto_compact_token_limit = 750000", ""].join(
          "\n",
        ),
      );
      writeFileSync(
        join(hostCodexHome, "models_cache.json"),
        JSON.stringify(
          {
            models: [
              {
                slug: "gpt-5.5",
                context_window: 272000,
                max_context_window: 272000,
                auto_compact_token_limit: null,
                effective_context_window_percent: 95,
              },
              {
                slug: "gpt-5.4",
                context_window: 272000,
                max_context_window: 1000000,
                auto_compact_token_limit: null,
                effective_context_window_percent: 95,
              },
            ],
          },
          null,
          2,
        ),
      );

      mockResolveBinary.mockImplementation((name: string): string | null => {
        if (name === wrapperPath) return wrapperPath;
        return "/usr/bin/claude";
      });
      mockCaptureUserShellEnv.mockReturnValue({});
      mockSpawn.mockReturnValueOnce(createMockCodexProc());

      await launcher.launch({
        backendType: "codex",
        cwd: "/tmp/project",
        codexSandbox: "workspace-write",
        codexBinary: wrapperPath,
        codexHome: customHome,
        codexLeaderContextWindowOverrideTokens: 1_000_000,
        env: {
          TAKODE_ROLE: "orchestrator",
        },
      });
      await waitForSpawnCalls(1);

      const config = realReadFileSync(configPath, "utf-8");
      expect(config).toContain(`model_catalog_json = ${JSON.stringify(catalogPath)}`);

      const catalog = JSON.parse(realReadFileSync(catalogPath, "utf-8"));
      const overridden = catalog.models.find((entry: any) => entry.slug === "gpt-5.5");
      expect(overridden.context_window).toBe(1_052_632);
      expect(overridden.max_context_window).toBe(1_052_632);
      expect(overridden.auto_compact_token_limit).toBe(1_000_000);

      const untouched = catalog.models.find((entry: any) => entry.slug === "gpt-5.4");
      expect(untouched.context_window).toBe(272000);
      expect(untouched.max_context_window).toBe(1000000);
      expect(untouched.auto_compact_token_limit).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(customHome, { recursive: true, force: true });
      rmSync(hostCodexHome, { recursive: true, force: true });
    }
  });

  it("falls back to the legacy Codex model cache when the wrapper host home has no source catalog", async () => {
    const customHome = mkdtempSync(join(tmpdir(), "codex-home-test-"));
    const hostCodexHome = mkdtempSync(join(tmpdir(), "codex-host-home-test-"));
    const sessionHome = join(customHome, "test-session-id");
    const configPath = join(sessionHome, "config.toml");
    const catalogPath = join(sessionHome, "takode-leader-model-catalog.json");
    const { root, wrapperPath } = createMaiWrapperFixture({ hostCodexHome });
    const { readFileSync: realReadFileSync } = require("node:fs");
    const legacyCachePath = join(homedir(), ".codex", "models_cache.json");

    try {
      writeFileSync(join(hostCodexHome, "config.toml"), ['model = "gpt-5.5"', ""].join("\n"));
      mockExistsSync.mockImplementation((path: string) => path === legacyCachePath);
      mockReadFileSync.mockImplementation((path: string) => {
        if (path === legacyCachePath) {
          return JSON.stringify(
            {
              models: [
                {
                  slug: "gpt-5.5",
                  display_name: "GPT-5.5",
                  description: "Newest model",
                  effective_context_window_percent: 95,
                  context_window: 272000,
                  max_context_window: 272000,
                  auto_compact_token_limit: null,
                  visibility: "list",
                },
              ],
            },
            null,
            2,
          );
        }
        return "";
      });

      mockResolveBinary.mockImplementation((name: string): string | null => {
        if (name === wrapperPath) return wrapperPath;
        return "/usr/bin/claude";
      });
      mockCaptureUserShellEnv.mockReturnValue({});
      mockSpawn.mockReturnValueOnce(createMockCodexProc());

      await launcher.launch({
        backendType: "codex",
        cwd: "/tmp/project",
        codexSandbox: "workspace-write",
        codexBinary: wrapperPath,
        codexHome: customHome,
        codexLeaderContextWindowOverrideTokens: 1_000_000,
        env: {
          TAKODE_ROLE: "orchestrator",
        },
      });
      await waitForSpawnCalls(1);

      const config = realReadFileSync(configPath, "utf-8");
      expect(config).toContain(`model_catalog_json = ${JSON.stringify(catalogPath)}`);

      const catalog = JSON.parse(realReadFileSync(catalogPath, "utf-8"));
      expect(catalog.models).toEqual([
        {
          slug: "gpt-5.5",
          display_name: "GPT-5.5",
          description: "Newest model",
          effective_context_window_percent: 95,
          context_window: 1_052_632,
          max_context_window: 1_052_632,
          auto_compact_token_limit: 1_000_000,
          visibility: "list",
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(customHome, { recursive: true, force: true });
      rmSync(hostCodexHome, { recursive: true, force: true });
    }
  });

  it("does not inject legacy Codex auth for MAI-wrapper sessions when the wrapper host home has no auth.json", async () => {
    const customHome = mkdtempSync(join(tmpdir(), "codex-home-test-"));
    const hostCodexHome = mkdtempSync(join(tmpdir(), "codex-host-home-test-"));
    const sessionHome = join(customHome, "test-session-id");
    const legacyAuthPath = join(homedir(), ".codex", "auth.json");
    const sessionAuthPath = join(sessionHome, "auth.json");
    const { root, wrapperPath } = createMaiWrapperFixture({ hostCodexHome });

    try {
      writeFileSync(join(hostCodexHome, "config.toml"), ['model = "gpt-5.5"', ""].join("\n"));
      mkdirSync(sessionHome, { recursive: true });
      symlinkSync(legacyAuthPath, sessionAuthPath);

      mockExistsSync.mockImplementation((path: string) => {
        if (path === legacyAuthPath) return true;
        return false;
      });

      mockResolveBinary.mockImplementation((name: string): string | null => {
        if (name === wrapperPath) return wrapperPath;
        return "/usr/bin/claude";
      });
      mockCaptureUserShellEnv.mockReturnValue({});
      mockSpawn.mockReturnValueOnce(createMockCodexProc());

      await launcher.launch({
        backendType: "codex",
        cwd: "/tmp/project",
        codexSandbox: "workspace-write",
        codexBinary: wrapperPath,
        codexHome: customHome,
        env: {
          TAKODE_ROLE: "orchestrator",
        },
      });
      await waitForSpawnCalls(1);

      expect(mockSymlink).not.toHaveBeenCalledWith(legacyAuthPath, sessionAuthPath);
      expect(existsSync(sessionAuthPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(customHome, { recursive: true, force: true });
      rmSync(hostCodexHome, { recursive: true, force: true });
    }
  });

  it("links MAI-wrapper session auth to the wrapper host auth when present", async () => {
    const customHome = mkdtempSync(join(tmpdir(), "codex-home-test-"));
    const hostCodexHome = mkdtempSync(join(tmpdir(), "codex-host-home-test-"));
    const sessionHome = join(customHome, "test-session-id");
    const hostAuthPath = join(hostCodexHome, "auth.json");
    const sessionAuthPath = join(sessionHome, "auth.json");
    const { root, wrapperPath } = createMaiWrapperFixture({ hostCodexHome });

    try {
      writeFileSync(hostAuthPath, '{"tokens":{"id_token":"wrapper-host"}}\n', "utf-8");
      writeFileSync(join(hostCodexHome, "config.toml"), ['model = "gpt-5.5"', ""].join("\n"));

      mockResolveBinary.mockImplementation((name: string): string | null => {
        if (name === wrapperPath) return wrapperPath;
        return "/usr/bin/claude";
      });
      mockCaptureUserShellEnv.mockReturnValue({});
      mockSpawn.mockReturnValueOnce(createMockCodexProc());

      await launcher.launch({
        backendType: "codex",
        cwd: "/tmp/project",
        codexSandbox: "workspace-write",
        codexBinary: wrapperPath,
        codexHome: customHome,
        env: {
          TAKODE_ROLE: "orchestrator",
        },
      });
      await waitForSpawnCalls(1);

      expect(lstatSync(sessionAuthPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(sessionAuthPath)).toBe(hostAuthPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(customHome, { recursive: true, force: true });
      rmSync(hostCodexHome, { recursive: true, force: true });
    }
  });

  it("launches MAI-wrapper-backed Codex workers without installing the wrapper CODEX_HOME overlay", async () => {
    const customHome = mkdtempSync(join(tmpdir(), "codex-home-test-"));
    const sessionHome = join(customHome, "test-session-id");
    const shimDir = join(sessionHome, ".mai-wrapper-bin");
    const { existsSync: realExistsSync } = require("node:fs");
    const { root, wrapperPath } = createMaiWrapperFixture();

    try {
      mockResolveBinary.mockImplementation((name: string): string | null => {
        if (name === wrapperPath) return wrapperPath;
        return "/usr/bin/claude";
      });
      mockCaptureUserShellEnv.mockReturnValue({});
      mockSpawn.mockReturnValueOnce(createMockCodexProc());

      await launcher.launch({
        backendType: "codex",
        cwd: "/tmp/project",
        codexSandbox: "workspace-write",
        codexBinary: wrapperPath,
        codexHome: customHome,
      });
      await waitForSpawnCalls(1);

      const [cmdAndArgs, options] = mockSpawn.mock.calls[0]!;
      expect(cmdAndArgs[0]).toBe(wrapperPath);
      expect(options.env.PATH.split(":")[0]).not.toBe(shimDir);
      expect(realExistsSync(getMaiWrapperSessionEnvPath(root))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(customHome, { recursive: true, force: true });
    }
  });

  it("bootstraps MAI-wrapper-backed Codex session homes from the wrapper CODEX_HOME", async () => {
    mockResolveBinary.mockReturnValue("/tmp/unused");
    mockSpawn.mockReturnValueOnce(createMockCodexProc());

    const hostCodexHome = "/Users/test/.codex/hosts/test-host";
    const sessionHome = "/Users/test/.companion/codex-home/test-session-id";
    const { root, wrapperPath } = createMaiWrapperFixture({ hostCodexHome });

    try {
      mockResolveBinary.mockImplementation((name: string): string | null => {
        if (name === wrapperPath) return wrapperPath;
        return "/usr/bin/claude";
      });
      mockCaptureUserShellEnv.mockReturnValue({});
      mockExistingPaths(
        hostCodexHome,
        join(hostCodexHome, "skills"),
        join(hostCodexHome, "vendor_imports"),
        join(hostCodexHome, "prompts"),
        join(hostCodexHome, "rules"),
      );

      await launcher.launch({
        backendType: "codex",
        cwd: "/tmp/project",
        codexSandbox: "workspace-write",
        codexBinary: wrapperPath,
        codexHome: "/Users/test/.companion/codex-home",
      });
      await waitForSpawnCalls(1);

      expect(mockCp).toHaveBeenCalledWith(join(hostCodexHome, "vendor_imports"), join(sessionHome, "vendor_imports"), {
        recursive: true,
      });
      expect(mockCp).not.toHaveBeenCalledWith(join(homedir(), ".codex", "skills"), join(sessionHome, "skills"), {
        recursive: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("migrates legacy-only Codex skills into the official agents skill home", async () => {
    // Validates .agents is the active Codex skill source, with ~/.codex/skills
    // used only to preserve slugs that have not been migrated yet.
    mockResolveBinary.mockReturnValue("/opt/fake/codex");
    mockSpawn.mockReturnValueOnce(createMockCodexProc());

    const agentsSkills = join(homedir(), ".agents", "skills");
    const legacyHome = join(homedir(), ".codex");
    const legacySkills = join(legacyHome, "skills");
    const sessionSkills = join(homedir(), ".companion", "codex-home", "test-session-id", "skills");
    const legacyReview = join(legacySkills, "review");
    const legacyOnly = join(legacySkills, "legacy-only");

    mockExistingPaths(agentsSkills, legacyHome, legacySkills, join(agentsSkills, "review"));
    mockReaddir.mockImplementation(async (path: string, options?: { withFileTypes?: boolean }) => {
      if (path === agentsSkills && options?.withFileTypes) {
        return [mockDirent("review")];
      }
      if (path === legacySkills && options?.withFileTypes) {
        return [mockDirent("review"), mockDirent("legacy-only")];
      }
      return [];
    });

    await launchCodex();

    expect(mockRm).toHaveBeenCalledWith(sessionSkills, { recursive: true, force: true });
    expect(mockCp).not.toHaveBeenCalledWith(legacyReview, join(agentsSkills, "review"), { recursive: true });
    expect(mockCp).toHaveBeenCalledWith(legacyOnly, join(agentsSkills, "legacy-only"), { recursive: true });
    expect(mockCp).not.toHaveBeenCalledWith(legacyOnly, join(sessionSkills, "legacy-only"), { recursive: true });
  });

  it("migrates MAI-wrapper-backed legacy skills without mutating existing agents system skills", async () => {
    const customHome = mkdtempSync(join(tmpdir(), "codex-home-test-"));
    const hostCodexHome = mkdtempSync(join(tmpdir(), "codex-host-home-test-"));
    const sharedSkills = mkdtempSync(join(tmpdir(), "codex-shared-skills-test-"));
    const sessionHome = join(customHome, "test-session-id");
    const sessionSkills = join(sessionHome, "skills");
    const agentsSkills = join(homedir(), ".agents", "skills");
    const { root, wrapperPath } = createMaiWrapperFixture({ hostCodexHome });

    try {
      mkdirSync(join(sharedSkills, ".system"), { recursive: true });
      writeFileSync(join(sharedSkills, ".system", "README.txt"), "shared skill\n");
      mkdirSync(join(sharedSkills, ".system", "imagegen"), { recursive: true });
      writeFileSync(join(sharedSkills, ".system", "imagegen", "SKILL.md"), "shared imagegen skill\n");
      mkdirSync(join(sharedSkills, "quest"), { recursive: true });
      writeFileSync(join(sharedSkills, "quest", "SKILL.md"), "shared quest skill\n");
      symlinkSync(sharedSkills, join(hostCodexHome, "skills"));

      mkdirSync(join(sessionSkills, ".system", "imagegen"), { recursive: true });
      writeFileSync(join(sessionSkills, ".system", "imagegen", "SKILL.md"), "stale copied skill\n");
      mockExistingPaths(join(agentsSkills, ".system"));

      mockResolveBinary.mockImplementation((name: string): string | null => {
        if (name === wrapperPath) return wrapperPath;
        return "/usr/bin/claude";
      });
      mockCaptureUserShellEnv.mockReturnValue({});
      mockSpawn.mockReturnValueOnce(createMockCodexProc());

      await launcher.launch({
        backendType: "codex",
        cwd: "/tmp/project",
        codexSandbox: "workspace-write",
        codexBinary: wrapperPath,
        codexHome: customHome,
      });
      await waitForSpawnCalls(1);

      const resolvedSharedSkills = realpathSync(sharedSkills);
      expect(existsSync(sessionSkills)).toBe(false);
      expect(mockCp).toHaveBeenCalledWith(
        join(resolvedSharedSkills, "quest", "SKILL.md"),
        join(agentsSkills, "quest", "SKILL.md"),
        { recursive: true },
      );
      expect(mockRm).not.toHaveBeenCalledWith(join(agentsSkills, ".system"), { recursive: true, force: true });
      expect(mockCp).not.toHaveBeenCalledWith(
        join(resolvedSharedSkills, ".system", "README.txt"),
        join(agentsSkills, ".system", "README.txt"),
        { recursive: true },
      );
      expect(mockCp).not.toHaveBeenCalledWith(
        join(resolvedSharedSkills, ".system", "imagegen"),
        join(agentsSkills, ".system", "imagegen"),
        { recursive: true },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(customHome, { recursive: true, force: true });
      rmSync(hostCodexHome, { recursive: true, force: true });
      rmSync(sharedSkills, { recursive: true, force: true });
    }
  });

  it("applies the context-window override to containerized Codex leaders only", async () => {
    const customHome = mkdtempSync(join(tmpdir(), "codex-container-home-test-"));

    try {
      mockSpawn.mockReturnValueOnce(createMockCodexProc());
      const workerInfo = await launcher.launch({
        backendType: "codex",
        cwd: "/tmp/project",
        codexSandbox: "workspace-write",
        codexHome: customHome,
        codexLeaderContextWindowOverrideTokens: 1_000_000,
        containerId: "abc123def456",
        containerName: "companion-session-1",
        containerImage: "ubuntu:22.04",
      });
      await waitForSpawnCalls(1);

      let [cmdAndArgs] = mockSpawn.mock.calls[0]!;
      expect(cmdAndArgs).toContain("docker");
      expect(cmdAndArgs).toContain("exec");
      expect(cmdAndArgs).toContain("CODEX_HOME=/root/.codex");
      let bashIndex = cmdAndArgs.indexOf("-lc");
      expect(bashIndex).toBeGreaterThan(-1);
      let innerScript = cmdAndArgs[bashIndex + 1];
      expect(innerScript).not.toContain("model_context_window = 1000000");
      expect(innerScript).not.toContain("model_auto_compact_token_limit = 1000000");

      (launcher.getSession(workerInfo.sessionId) as any).isOrchestrator = true;
      launcher.setSettingsGetter(() => ({
        claudeBinary: "",
        codexBinary: "codex",
        codexLeaderContextWindowOverrideTokens: 1_000_000,
      }));
      mockSpawn.mockReturnValueOnce(createMockCodexProc(12346));
      const relaunch = await launcher.relaunch(workerInfo.sessionId);
      expect(relaunch.ok).toBe(true);
      await waitForSpawnCalls(2);

      [cmdAndArgs] = mockSpawn.mock.calls[1]!;
      expect(cmdAndArgs).toContain("CODEX_HOME=/root/.codex");
      bashIndex = cmdAndArgs.indexOf("-lc");
      expect(bashIndex).toBeGreaterThan(-1);
      innerScript = cmdAndArgs[bashIndex + 1];
      expect(innerScript).toContain("cat > \"/root/.codex/config.toml\" <<'__COMPANION_CODEX_CONFIG__'");
      expect(innerScript).toContain("model_context_window = 1000000");
      expect(innerScript).toContain("model_auto_compact_token_limit = 1000000");
      expect(innerScript).toContain("exec 'codex' '-c' 'tools.webSearch=false' '-a'");
    } finally {
      rmSync(customHome, { recursive: true, force: true });
    }
  });

  it("records Codex leader recycle lineage across fresh-thread swaps", async () => {
    mockResolveBinary.mockReturnValue("/opt/fake/codex");
    mockSpawn.mockReturnValueOnce(createMockCodexProc());

    const info = await launchCodex();

    const session = launcher.getSession(info.sessionId)!;
    session.isOrchestrator = true;
    launcher.setCLISessionId(info.sessionId, "thread-a");

    const prepared = launcher.prepareCodexLeaderRecycle(info.sessionId, {
      trigger: "threshold",
      tokenUsage: {
        contextTokensUsed: 270_000,
        contextUsedPercent: 27,
      },
    });

    expect(prepared.ok).toBe(true);
    expect(session.codexLeaderRecyclePending).toEqual(
      expect.objectContaining({
        eventIndex: 0,
        trigger: "threshold",
      }),
    );
    expect(session.codexLeaderRecycleLineage?.cliSessionIds).toEqual(["thread-a"]);
    expect(session.codexLeaderRecycleLineage?.recycleEvents).toEqual([
      expect.objectContaining({
        trigger: "threshold",
        previousCliSessionId: "thread-a",
        tokenUsage: expect.objectContaining({
          contextTokensUsed: 270_000,
          contextUsedPercent: 27,
        }),
      }),
    ]);

    launcher.setCLISessionId(info.sessionId, "thread-b");
    expect(session.codexLeaderRecycleLineage?.cliSessionIds).toEqual(["thread-a", "thread-b"]);
    expect(session.codexLeaderRecycleLineage?.recycleEvents[0]?.nextCliSessionId).toBe("thread-b");

    launcher.completeCodexLeaderRecycle(info.sessionId);
    expect(session.codexLeaderRecyclePending).toBeNull();
  });

  it("refreshes auth.json from the legacy Codex home even when the session copy already exists", async () => {
    mockResolveBinary.mockReturnValue("/opt/fake/codex");
    mockSpawn.mockReturnValueOnce(createMockCodexProc());

    const legacyHome = join(homedir(), ".codex");
    const sessionHome = join(homedir(), ".companion", "codex-home", "test-session-id");
    const legacyAuth = join(legacyHome, "auth.json");
    const sessionAuth = join(sessionHome, "auth.json");

    mockExistingPaths(legacyHome, legacyAuth, sessionAuth);

    await launchCodex();

    expect(mockSymlink).toHaveBeenCalledWith(legacyAuth, sessionAuth);
  });

  it("replaces broken agents skill symlinks before legacy fallback migration", async () => {
    // Legacy migrations can leave broken ~/.agents/skills symlinks. A missing
    // slug fallback must replace those placeholders with usable skill contents.
    mockResolveBinary.mockReturnValue("/opt/fake/codex");
    mockSpawn.mockReturnValueOnce(createMockCodexProc());

    const agentsSkills = join(homedir(), ".agents", "skills");
    const legacyHome = join(homedir(), ".codex");
    const legacySkills = join(legacyHome, "skills");
    const brokenSkill = join(agentsSkills, "cron-scheduling");

    mockExistingPaths(agentsSkills, legacyHome, legacySkills);
    mockReaddir.mockImplementation(async (path: string, options?: { withFileTypes?: boolean }) => {
      if (path === legacySkills && options?.withFileTypes) {
        return [mockDirent("cron-scheduling", { symlink: true, directory: false })];
      }
      if (path === agentsSkills && options?.withFileTypes) {
        return [mockDirent("cron-scheduling", { symlink: true, directory: false })];
      }
      return [];
    });
    mockLstatSync.mockImplementation((path?: string) => {
      if (path === brokenSkill) {
        return {
          isSymbolicLink: () => true,
          isDirectory: () => false,
        };
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    await launchCodex();

    expect(mockCp).toHaveBeenCalledWith(join(legacySkills, "cron-scheduling"), brokenSkill, { recursive: true });
    expect(mockUnlink).toHaveBeenCalledWith(brokenSkill);
  });

  it("removes deprecated session Codex skill directories on relaunch", async () => {
    // CODEX_HOME/skills used to be populated as a custom skill root. New
    // launches remove it so official ~/.agents/skills remains the active path.
    mockResolveBinary.mockReturnValue("/opt/fake/codex");
    mockSpawn.mockReturnValueOnce(createMockCodexProc());

    const legacyHome = join(homedir(), ".codex");
    const sessionHome = join(homedir(), ".companion", "codex-home", "test-session-id");
    const sessionSkills = join(sessionHome, "skills");

    mockExistingPaths(legacyHome, sessionSkills);

    await launchCodex();

    expect(mockRm).toHaveBeenCalledWith(sessionSkills, { recursive: true, force: true });
    expect(mockCp).not.toHaveBeenCalledWith(join(legacyHome, "skills"), sessionSkills, { recursive: true });
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

    await launchCodex({ resumeCliSessionId: "thread-abc" });

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
      await launchCodex({
        codexHome: customHome,
        env: {
          COMPANION_PORT: "3456",
          TAKODE_ROLE: "orchestrator",
          TAKODE_API_PORT: "3456",
        },
      });

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

  it("builds host Codex PATH from enriched startup data without hot-path shell capture", async () => {
    mockResolveBinary.mockReturnValue("/opt/fake/codex");
    mockSpawn.mockReturnValueOnce(createMockCodexProc());
    mockCaptureUserShellPath.mockImplementation(() => {
      throw new Error("host Codex launch should not re-capture shell PATH");
    });
    mockCaptureUserShellEnv.mockReturnValue({ LITELLM_API_KEY: "startup-warmed-key" });
    mockGetEnrichedPath.mockReturnValue(
      "/opt/homebrew/bin:/Users/test/.bun/bin:/usr/local/share/companion-extra:/usr/bin:/bin",
    );
    process.env.LITELLM_API_KEY = "stale-daemon-key";

    await launchCodex({ codexInternetAccess: true });

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
    expect(options.env.LITELLM_API_KEY).toBe("startup-warmed-key");
    expect(mockCaptureUserShellEnv).toHaveBeenCalledWith(["LITELLM_API_KEY", "LITELLM_PROXY_URL", "LITELLM_BASE_URL"], {
      allowShellSpawn: false,
    });
    expect(mockCaptureUserShellPath).not.toHaveBeenCalled();
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

    await launchCodex();

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

    await launchCodex();

    const [cmdAndArgs] = mockSpawn.mock.calls[0];
    expect(cmdAndArgs[0]).toBe(fakeCodex);
    expect(cmdAndArgs.slice(1, 5)).toEqual(["-c", "tools.webSearch=false", "-a", "untrusted"]);

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
