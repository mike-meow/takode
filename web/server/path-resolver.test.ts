import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Hoisted mocks ──────────────────────────────────────────────────────────

const mockExecSync = vi.hoisted(() => vi.fn());
const mockExecFileSync = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn((_path: string) => false));
const mockReaddirSync = vi.hoisted(() => vi.fn((_path: string) => [] as string[]));
const mockHomedir = vi.hoisted(() => vi.fn(() => "/home/testuser"));

vi.mock("node:child_process", () => ({ execFileSync: mockExecFileSync, execSync: mockExecSync }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: mockExistsSync,
    readdirSync: mockReaddirSync,
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: mockHomedir,
  };
});

// ─── Import after mocks ─────────────────────────────────────────────────────

import {
  captureUserShellPath,
  captureUserShellEnv,
  buildFallbackPath,
  getEnrichedPath,
  resolveBinary,
  getServicePath,
  expandTilde,
  _resetPathCache,
  _resetShellEnvCache,
} from "./path-resolver.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  _resetPathCache();
  _resetShellEnvCache();
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = originalEnv;
});

// ─── captureUserShellPath ───────────────────────────────────────────────────

describe("captureUserShellPath", () => {
  it("extracts PATH from login shell output using sentinel markers", () => {
    mockExecFileSync.mockReturnValueOnce(
      "___PATH_START___/usr/bin:/home/testuser/.nvm/versions/node/v20/bin:/home/testuser/.cargo/bin___PATH_END___\n",
    );

    const result = captureUserShellPath();
    expect(result).toBe("/usr/bin:/home/testuser/.nvm/versions/node/v20/bin:/home/testuser/.cargo/bin");
  });

  it("handles noisy shell output (MOTD, warnings) before and after PATH", () => {
    mockExecFileSync.mockReturnValueOnce(
      "Last login: Mon Jan 1\nWelcome!\n___PATH_START___/usr/local/bin:/usr/bin___PATH_END___\nbye\n",
    );

    const result = captureUserShellPath();
    expect(result).toBe("/usr/local/bin:/usr/bin");
  });

  it("falls back to buildFallbackPath when shell sourcing fails", () => {
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error("shell failed");
    });
    // buildFallbackPath needs existsSync to return true for some dirs
    mockExistsSync.mockImplementation((p: string) => p === "/usr/bin" || p === "/bin");

    const result = captureUserShellPath();
    expect(result).toContain("/usr/bin");
    expect(result).toContain("/bin");
  });

  it("falls back when shell output contains no sentinel markers", () => {
    mockExecFileSync.mockReturnValueOnce("some garbage output\n");
    mockExistsSync.mockImplementation((p: string) => p === "/usr/bin");

    const result = captureUserShellPath();
    // Should fall back to buildFallbackPath
    expect(result).toContain("/usr/bin");
  });

  it("uses $SHELL env var for the shell command", () => {
    process.env.SHELL = "/bin/zsh";
    mockExecFileSync.mockReturnValueOnce("___PATH_START___/usr/bin___PATH_END___\n");

    captureUserShellPath();

    expect(mockExecFileSync).toHaveBeenCalledWith("/bin/zsh", expect.any(Array), expect.any(Object));
  });

  it("defaults to /bin/bash when $SHELL is not set", () => {
    delete process.env.SHELL;
    mockExecFileSync.mockReturnValueOnce("___PATH_START___/usr/bin___PATH_END___\n");

    captureUserShellPath();

    expect(mockExecFileSync).toHaveBeenCalledWith("/bin/bash", expect.any(Array), expect.any(Object));
  });

  it("runs the login shell directly instead of through an intermediate shell", () => {
    process.env.SHELL = "/bin/zsh";
    mockExecFileSync.mockReturnValueOnce("___PATH_START___/usr/bin___PATH_END___\n");

    captureUserShellPath();

    // Regression coverage for q-52: using execSync with a shell command string
    // let timed-out `zsh -lic ...` probes survive as orphaned PID-1 children.
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "/bin/zsh",
      ["-lic", 'echo "___PATH_START___$PATH___PATH_END___"'],
      expect.objectContaining({ timeout: 10_000, killSignal: "SIGKILL" }),
    );
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

// ─── captureUserShellEnv ────────────────────────────────────────────────────

describe("captureUserShellEnv", () => {
  it("runs the env capture shell directly instead of through an intermediate shell", () => {
    process.env.SHELL = "/bin/zsh";
    mockExecFileSync.mockReturnValueOnce("___ENV_LITELLM_API_KEY___=secret\n");

    const result = captureUserShellEnv(["LITELLM_API_KEY"]);

    // This protects the same process-ownership path as PATH capture, but for
    // the one-time login-shell env probe used by Codex launcher setup.
    expect(result).toEqual({ LITELLM_API_KEY: "secret" });
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "/bin/zsh",
      ["-lic", 'echo "___ENV_LITELLM_API_KEY___=${LITELLM_API_KEY:-}"'],
      expect.objectContaining({ timeout: 10_000, killSignal: "SIGKILL" }),
    );
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

// ─── buildFallbackPath ──────────────────────────────────────────────────────

describe("buildFallbackPath", () => {
  it("includes standard system paths when they exist", () => {
    mockExistsSync.mockImplementation((p: string) => ["/usr/local/bin", "/usr/bin", "/bin"].includes(p as string));

    const result = buildFallbackPath();
    expect(result).toContain("/usr/local/bin");
    expect(result).toContain("/usr/bin");
    expect(result).toContain("/bin");
  });

  it("includes ~/.local/bin for claude CLI", () => {
    mockExistsSync.mockImplementation((p: string) => p === "/home/testuser/.local/bin" || p === "/usr/bin");

    const result = buildFallbackPath();
    expect(result).toContain("/home/testuser/.local/bin");
  });

  it("includes ~/.bun/bin", () => {
    mockExistsSync.mockImplementation((p: string) => p === "/home/testuser/.bun/bin" || p === "/usr/bin");

    const result = buildFallbackPath();
    expect(result).toContain("/home/testuser/.bun/bin");
  });

  it("includes ~/.cargo/bin for Rust tools", () => {
    mockExistsSync.mockImplementation((p: string) => p === "/home/testuser/.cargo/bin" || p === "/usr/bin");

    const result = buildFallbackPath();
    expect(result).toContain("/home/testuser/.cargo/bin");
  });

  it("probes nvm versions directory and includes all version bins", () => {
    // Ensure NVM_DIR is not set so the code falls back to ~/.nvm
    delete process.env.NVM_DIR;
    mockExistsSync.mockImplementation((p: string) => {
      if (p === "/home/testuser/.nvm/versions/node") return true;
      if (p.includes(".nvm/versions/node/v") && p.endsWith("/bin")) return true;
      if (p === "/usr/bin") return true;
      return false;
    });
    mockReaddirSync.mockReturnValue(["v18.20.0", "v22.17.0"] as any);

    const result = buildFallbackPath();
    expect(result).toContain("/home/testuser/.nvm/versions/node/v18.20.0/bin");
    expect(result).toContain("/home/testuser/.nvm/versions/node/v22.17.0/bin");
  });

  it("uses NVM_DIR env var when set", () => {
    process.env.NVM_DIR = "/custom/nvm";
    mockExistsSync.mockImplementation((p: string) => {
      if (p === "/custom/nvm/versions/node") return true;
      if (p.includes("/custom/nvm/versions/node/v") && p.endsWith("/bin")) return true;
      return false;
    });
    mockReaddirSync.mockReturnValue(["v20.0.0"] as any);

    const result = buildFallbackPath();
    expect(result).toContain("/custom/nvm/versions/node/v20.0.0/bin");
  });

  it("excludes directories that don't exist", () => {
    mockExistsSync.mockReturnValue(false);

    const result = buildFallbackPath();
    expect(result).toBe("");
  });

  it("deduplicates PATH entries", () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([] as any);

    const result = buildFallbackPath();
    const dirs = result.split(":");
    expect(dirs.length).toBe(new Set(dirs).size);
  });
});

// ─── getEnrichedPath ────────────────────────────────────────────────────────

describe("getEnrichedPath", () => {
  it("merges user shell PATH with current process PATH", () => {
    process.env.PATH = "/usr/bin:/bin";
    mockExecFileSync.mockReturnValueOnce("___PATH_START___/usr/bin:/home/testuser/.cargo/bin___PATH_END___\n");

    const result = getEnrichedPath();
    expect(result).toContain("/home/testuser/.cargo/bin");
    expect(result).toContain("/usr/bin");
    expect(result).toContain("/bin");
  });

  it("deduplicates entries from both PATHs", () => {
    process.env.PATH = "/usr/bin:/bin:/usr/local/bin";
    mockExecFileSync.mockReturnValueOnce(
      "___PATH_START___/usr/bin:/usr/local/bin:/home/testuser/.volta/bin___PATH_END___\n",
    );

    const result = getEnrichedPath();
    const dirs = result.split(":");
    expect(dirs.length).toBe(new Set(dirs).size);
    // /usr/bin should appear exactly once
    expect(dirs.filter((d) => d === "/usr/bin").length).toBe(1);
  });

  it("caches the result after first call", () => {
    process.env.PATH = "/usr/bin";
    mockExecFileSync.mockReturnValueOnce("___PATH_START___/usr/bin___PATH_END___\n");

    const first = getEnrichedPath();
    mockExecFileSync.mockClear();
    const second = getEnrichedPath();

    expect(first).toBe(second);
    // execFileSync should NOT be called again (result was cached)
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("gives user shell PATH precedence over process PATH", () => {
    // User's shell has /opt/homebrew/bin first, process PATH has /usr/bin first
    process.env.PATH = "/usr/bin:/bin";
    mockExecFileSync.mockReturnValueOnce("___PATH_START___/opt/homebrew/bin:/usr/bin___PATH_END___\n");

    const result = getEnrichedPath();
    const dirs = result.split(":");
    expect(dirs.indexOf("/opt/homebrew/bin")).toBeLessThan(dirs.indexOf("/bin"));
  });

  it("always prefixes built-in shim directories", () => {
    process.env.PATH = "/usr/bin:/bin";
    mockExecFileSync.mockReturnValueOnce("___PATH_START___/opt/homebrew/bin:/usr/bin___PATH_END___\n");

    const result = getEnrichedPath();
    const dirs = result.split(":");
    expect(dirs[0]).toBe("/home/testuser/.companion/bin");
    expect(dirs[1]).toBe("/home/testuser/.local/bin");
    expect(dirs).toContain("/opt/homebrew/bin");
  });

  it("does not add server-specific wrapper dirs when serverId is provided", () => {
    process.env.PATH = "/usr/bin:/bin";
    mockExecFileSync.mockReturnValueOnce("___PATH_START___/opt/homebrew/bin:/usr/bin___PATH_END___\n");

    const result = getEnrichedPath({ serverId: "server-a" });
    const dirs = result.split(":");
    expect(dirs[0]).toBe("/home/testuser/.companion/bin");
    expect(dirs[1]).toBe("/home/testuser/.local/bin");
    expect(dirs).not.toContain("/home/testuser/.companion/bin/servers/server-a");
  });

  it("reuses the same cached PATH regardless of serverId hints", () => {
    process.env.PATH = "/usr/bin";
    let callCount = 0;
    mockExecFileSync.mockImplementation(() => {
      callCount++;
      return `___PATH_START___/usr/bin:/call-${callCount}___PATH_END___\n`;
    });

    const serverAFirst = getEnrichedPath({ serverId: "server-a" });
    const serverASecond = getEnrichedPath({ serverId: "server-a" });
    const serverB = getEnrichedPath({ serverId: "server-b" });

    expect(serverAFirst).toBe(serverASecond);
    expect(serverAFirst).toBe(serverB);
    expect(serverAFirst).not.toContain("/servers/server-a");
    expect(serverB).not.toContain("/servers/server-b");
    expect(callCount).toBe(1);
  });
});

// ─── resolveBinary ──────────────────────────────────────────────────────────

describe("resolveBinary", () => {
  beforeEach(() => {
    // Seed getEnrichedPath cache to avoid shell-sourcing side effects
    process.env.PATH = "/usr/bin:/bin";
    mockExecFileSync.mockReturnValue("___PATH_START___/usr/bin:/usr/local/bin___PATH_END___\n");
    mockExecSync.mockImplementation(() => {
      throw new Error("not found");
    });
  });

  it("returns absolute path when binary is found via which", () => {
    _resetPathCache();
    mockExecFileSync.mockReturnValueOnce("___PATH_START___/usr/bin___PATH_END___\n");
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.startsWith("which claude")) {
        return "/home/testuser/.local/bin/claude\n";
      }
      throw new Error("not found");
    });

    expect(resolveBinary("claude")).toBe("/home/testuser/.local/bin/claude");
  });

  it("returns null when binary is not found anywhere", () => {
    _resetPathCache();
    mockExecFileSync.mockReturnValueOnce("___PATH_START___/usr/bin___PATH_END___\n");
    mockExecSync.mockImplementation(() => {
      throw new Error("not found");
    });

    expect(resolveBinary("nonexistent")).toBeNull();
  });

  it("passes enriched PATH to which command", () => {
    _resetPathCache();
    mockExecFileSync.mockReturnValueOnce("___PATH_START___/usr/bin:/home/testuser/.special/bin___PATH_END___\n");
    mockExecSync.mockImplementation((cmd: string, opts?: any) => {
      if (typeof cmd === "string" && cmd.startsWith("which")) {
        // Verify enriched PATH is passed in env
        expect(opts?.env?.PATH).toContain("/home/testuser/.special/bin");
        return "/home/testuser/.special/bin/mytool\n";
      }
      throw new Error("not found");
    });

    resolveBinary("mytool");
  });

  it("returns the path directly when given an absolute path that exists", () => {
    mockExistsSync.mockReturnValue(true);
    expect(resolveBinary("/opt/bin/claude")).toBe("/opt/bin/claude");
  });

  it("returns null when given an absolute path that does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    expect(resolveBinary("/nonexistent/claude")).toBeNull();
  });
});

// ─── getServicePath ─────────────────────────────────────────────────────────

describe("getServicePath", () => {
  it("returns the same value as getEnrichedPath", () => {
    process.env.PATH = "/usr/bin";
    mockExecFileSync.mockReturnValueOnce("___PATH_START___/usr/bin:/opt/homebrew/bin___PATH_END___\n");

    expect(getServicePath()).toBe(getEnrichedPath());
  });
});

// ─── expandTilde ─────────────────────────────────────────────────────────────

describe("expandTilde", () => {
  it("expands ~ to home directory", () => {
    expect(expandTilde("~")).toBe("/home/testuser");
  });

  it("expands ~/path to home directory + path", () => {
    expect(expandTilde("~/projects/HQ")).toBe("/home/testuser/projects/HQ");
  });

  it("expands ~/single-segment", () => {
    expect(expandTilde("~/HQ")).toBe("/home/testuser/HQ");
  });

  it("leaves absolute paths unchanged", () => {
    expect(expandTilde("/usr/local/bin")).toBe("/usr/local/bin");
  });

  it("leaves relative paths unchanged", () => {
    expect(expandTilde("relative/path")).toBe("relative/path");
  });

  it("does not expand tilde in the middle of a path", () => {
    expect(expandTilde("/some/~/path")).toBe("/some/~/path");
  });

  it("does not expand ~username patterns (unsupported)", () => {
    // ~otheruser/foo is left as-is — we only expand the current user's ~
    expect(expandTilde("~otheruser/foo")).toBe("~otheruser/foo");
  });
});

// ─── _resetPathCache ────────────────────────────────────────────────────────

describe("_resetPathCache", () => {
  it("clears the cached PATH so next call re-computes", () => {
    process.env.PATH = "/usr/bin";
    let callCount = 0;
    mockExecFileSync.mockImplementation(() => {
      callCount++;
      return `___PATH_START___/usr/bin:/call-${callCount}___PATH_END___\n`;
    });

    const first = getEnrichedPath();
    _resetPathCache();
    const second = getEnrichedPath();

    expect(first).not.toBe(second);
    expect(first).toContain("/call-1");
    expect(second).toContain("/call-2");
  });
});
