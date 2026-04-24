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

  it("leaves a tracked settings.json file in place instead of replacing it with a symlink", async () => {
    mockLstatSync.mockImplementation((path: any) => {
      if (path === join(WORKTREE, ".claude", "settings.json")) {
        return { isSymbolicLink: () => false };
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    mockExistsSync.mockImplementation((path: string) => {
      if (path === WORKTREE) return true;
      return false;
    });
    mockExec.mockImplementation((cmd: string, opts: any, cb: any) => {
      const callback = typeof opts === "function" ? opts : cb;
      if (cmd.includes('git --no-optional-locks ls-files --error-unmatch -- ".claude/settings.json"')) {
        callback(null, ".claude/settings.json\n", "");
        return;
      }
      if (cmd.includes("git --no-optional-locks ls-files --error-unmatch --")) {
        callback(
          Object.assign(new Error("Command failed: git ls-files"), {
            code: 1,
            stderr: "error: pathspec '.claude/settings.local.json' did not match any file(s) known to git",
          }),
          "",
          "",
        );
        return;
      }
      callback(null, "", "");
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

    expect(mockUnlinkSync).not.toHaveBeenCalledWith(join(WORKTREE, ".claude", "settings.json"));
    expect(mockSymlinkSync).not.toHaveBeenCalledWith(
      join(REPO_ROOT, ".claude", "settings.json"),
      join(WORKTREE, ".claude", "settings.json"),
    );
    expect(mockWriteFileSync).not.toHaveBeenCalledWith(
      join(REPO_ROOT, ".claude", "settings.json"),
      expect.anything(),
      "utf-8",
    );
    expect(mockSymlinkSync).toHaveBeenCalledWith(
      join(REPO_ROOT, ".claude", "settings.local.json"),
      join(WORKTREE, ".claude", "settings.local.json"),
    );
  });

  it("preserves a real settings.json file when git tracking check fails operationally", async () => {
    mockLstatSync.mockImplementation((path: any) => {
      if (path === join(WORKTREE, ".claude", "settings.json")) {
        return { isSymbolicLink: () => false };
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    mockExistsSync.mockImplementation((path: string) => {
      if (path === WORKTREE) return true;
      return false;
    });
    mockExec.mockImplementation((cmd: string, opts: any, cb: any) => {
      const callback = typeof opts === "function" ? opts : cb;
      if (cmd.includes('git --no-optional-locks ls-files --error-unmatch -- ".claude/settings.json"')) {
        callback(
          Object.assign(new Error("Command failed: git ls-files"), {
            code: 128,
            stderr: "fatal: not a git repository (or any of the parent directories): .git",
          }),
          "",
          "",
        );
        return;
      }
      if (cmd.includes("git --no-optional-locks ls-files --error-unmatch --")) {
        callback(
          Object.assign(new Error("Command failed: git ls-files"), {
            code: 1,
            stderr: "error: pathspec '.claude/settings.local.json' did not match any file(s) known to git",
          }),
          "",
          "",
        );
        return;
      }
      callback(null, "", "");
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

    expect(mockUnlinkSync).not.toHaveBeenCalledWith(join(WORKTREE, ".claude", "settings.json"));
    expect(mockSymlinkSync).not.toHaveBeenCalledWith(
      join(REPO_ROOT, ".claude", "settings.json"),
      join(WORKTREE, ".claude", "settings.json"),
    );
    expect(mockWriteFileSync).not.toHaveBeenCalledWith(
      join(REPO_ROOT, ".claude", "settings.json"),
      expect.anything(),
      "utf-8",
    );
    expect(mockSymlinkSync).toHaveBeenCalledWith(
      join(REPO_ROOT, ".claude", "settings.local.json"),
      join(WORKTREE, ".claude", "settings.local.json"),
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
