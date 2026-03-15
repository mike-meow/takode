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
  };
});

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import { SessionStore } from "./session-store.js";
import { CliLauncher } from "./cli-launcher.js";

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

  it("injects worktree quest sync guardrails into the Claude system prompt", async () => {
    await launchWorktree();

    const [cmdAndArgs] = mockSpawn.mock.calls[0];
    const promptIdx = cmdAndArgs.indexOf("--append-system-prompt");
    expect(promptIdx).toBeGreaterThan(-1);
    const prompt = String(cmdAndArgs[promptIdx + 1] ?? "");
    expect(prompt).toContain("### Quest Status Rule");
    expect(prompt).toContain("do **NOT** transition it to `needs_verification`");
    expect(prompt).toContain("main repo contains the changes");
    expect(prompt).toContain("branch has been pushed");
    expect(prompt).toContain("override any conflicting generic markdown-link or file-reference instructions");
    expect(prompt).toContain("Do not use plain absolute-path markdown links");
  });
});

describe("getOrchestratorGuardrails", () => {
  it("returns Claude-family guardrails with session link format for chat references", () => {
    // getOrchestratorGuardrails now returns a string instead of writing to a file.
    // Orchestrator instructions are injected via system prompt (extraInstructions).
    const guardrails = launcher.getOrchestratorGuardrails(3456, "claude");
    expect(guardrails).toContain("Takode — Cross-Session Orchestration");
    expect(guardrails).toContain("[#N](session:N)");
    expect(guardrails).toContain("[#5](session:5)");
    expect(guardrails).toContain("sub-agent");
    expect(guardrails).toContain("After your own context compaction, refresh worker state before dispatching.");
    expect(guardrails).toContain("Prefer reusing an idle existing worker over spawning a new one.");
    expect(guardrails).toContain(
      "Only use `takode spawn` when no suitable worker exists or when you explicitly need isolation.",
    );
  });

  it("returns Codex guardrails without Claude-only or sub-agent guidance", () => {
    const guardrails = launcher.getOrchestratorGuardrails(3456, "codex");
    expect(guardrails).toContain("leader session");
    expect(guardrails).toContain("Delegate larger work to a herded worker session");
    expect(guardrails).toContain("override any conflicting generic markdown-link or file-reference instructions");
    expect(guardrails).toContain("Do not use plain absolute-path markdown links");
    expect(guardrails).toContain("After your own context compaction, refresh worker state before dispatching.");
    expect(guardrails).toContain("Prefer reusing an idle existing worker over spawning a new one.");
    expect(guardrails).toContain(
      "Only use `takode spawn` when no suitable worker exists or when you explicitly need isolation.",
    );
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
    await setupSessions("orch-1", "orch-2", "worker-1");

    herdLauncher.herdSessions("orch-1", ["worker-1"]);
    const result = herdLauncher.herdSessions("orch-2", ["worker-1"]);

    // worker-1 stays with orch-1, orch-2 gets a conflict
    expect(result.herded).toEqual([]);
    expect(result.conflicts).toEqual([{ id: "worker-1", herder: "orch-1" }]);

    const worker = herdLauncher.getSession("worker-1");
    expect(worker?.herdedBy).toBe("orch-1"); // unchanged
  });

  it("unherds a session", async () => {
    await setupSessions("orch-1", "worker-1");

    herdLauncher.herdSessions("orch-1", ["worker-1"]);
    expect(herdLauncher.unherdSession("orch-1", "worker-1")).toBe(true);

    const worker = herdLauncher.getSession("worker-1");
    expect(worker?.herdedBy).toBeUndefined(); // cleaned up when empty
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
