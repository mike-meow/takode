import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoisted mocks ───────────────────────────────────────────────────────────

const mockHomedir = vi.hoisted(() => {
  let dir = "/fake/home";
  return { get: () => dir, set: (d: string) => { dir = d; } };
});

const mockExecSync = vi.hoisted(() => vi.fn());
const mockExecCb = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn());
const mockMkdirSync = vi.hoisted(() => vi.fn());

vi.mock("node:os", () => ({ homedir: () => mockHomedir.get() }));
vi.mock("node:child_process", () => ({
  execSync: mockExecSync,
  exec: mockExecCb,
}));
vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mockGitCommand(pattern: string | RegExp, result: string) {
  mockExecSync.mockImplementation((cmd: string) => {
    if (typeof pattern === "string" ? cmd.includes(pattern) : pattern.test(cmd)) {
      return result;
    }
    throw new Error(`Unexpected git command: ${cmd}`);
  });
}

function mockGitCommands(map: Record<string, string | Error>) {
  mockExecSync.mockImplementation((cmd: string) => {
    for (const [pattern, result] of Object.entries(map)) {
      if (cmd.includes(pattern)) {
        if (result instanceof Error) throw result;
        return result;
      }
    }
    throw new Error(`Unmocked git command: ${cmd}`);
  });
}

/**
 * Mock the callback-style `exec` used by the async functions (via promisify).
 * promisify(exec) calls exec(cmd, opts, cb) — we dispatch based on cmd content.
 */
function mockAsyncGitCommand(pattern: string | RegExp, result: string) {
  mockExecCb.mockImplementation((cmd: string, _opts: unknown, cb: Function) => {
    if (typeof pattern === "string" ? cmd.includes(pattern) : pattern.test(cmd)) {
      cb(null, { stdout: result + "\n", stderr: "" });
    } else {
      cb(new Error(`Unexpected git command: ${cmd}`), { stdout: "", stderr: "" });
    }
  });
}

function mockAsyncGitCommands(map: Record<string, string | Error>) {
  mockExecCb.mockImplementation((cmd: string, _opts: unknown, cb: Function) => {
    for (const [pattern, result] of Object.entries(map)) {
      if (cmd.includes(pattern)) {
        if (result instanceof Error) {
          cb(result, { stdout: "", stderr: "" });
          return;
        }
        cb(null, { stdout: result + "\n", stderr: "" });
        return;
      }
    }
    cb(new Error(`Unmocked async git command: ${cmd}`), { stdout: "", stderr: "" });
  });
}

// ─── Dynamic import with module reset ────────────────────────────────────────

let gitUtils: typeof import("./git-utils.js");

beforeEach(async () => {
  vi.resetModules();
  mockExecSync.mockReset();
  mockExecCb.mockReset();
  mockExistsSync.mockReset();
  mockMkdirSync.mockReset();
  mockHomedir.set("/fake/home");
  gitUtils = await import("./git-utils.js");
});

// ─── getRepoInfo ─────────────────────────────────────────────────────────────

describe("getRepoInfo", () => {
  it("returns null for a non-git directory", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("fatal: not a git repository");
    });

    const result = gitUtils.getRepoInfo("/tmp/not-a-repo");
    expect(result).toBeNull();
  });

  it("returns correct repo info for a standard git repo", () => {
    mockGitCommands({
      "rev-parse --show-toplevel": "/home/user/my-project",
      "rev-parse --abbrev-ref HEAD": "feat/cool-feature",
      "rev-parse --git-dir": ".git",
      "symbolic-ref refs/remotes/origin/HEAD": "refs/remotes/origin/main",
    });

    const result = gitUtils.getRepoInfo("/home/user/my-project");
    expect(result).toEqual({
      repoRoot: "/home/user/my-project",
      repoName: "my-project",
      currentBranch: "feat/cool-feature",
      defaultBranch: "main",
      isWorktree: false,
    });
  });

  it("detects worktree when git-dir contains /worktrees/", () => {
    mockGitCommands({
      "rev-parse --show-toplevel": "/fake/home/.companion/worktrees/proj/feat--x",
      "rev-parse --abbrev-ref HEAD": "feat/x",
      "rev-parse --git-dir": "/home/user/proj/.git/worktrees/feat--x",
      "symbolic-ref refs/remotes/origin/HEAD": "refs/remotes/origin/main",
    });

    const result = gitUtils.getRepoInfo("/fake/home/.companion/worktrees/proj/feat--x");
    expect(result).not.toBeNull();
    expect(result!.isWorktree).toBe(true);
  });

  it("falls back to 'HEAD' when branch detection fails", () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return "/repo";
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) throw new Error("detached HEAD");
      if (cmd.includes("rev-parse --git-dir")) return ".git";
      if (cmd.includes("symbolic-ref refs/remotes/origin/HEAD")) return "refs/remotes/origin/main";
      throw new Error(`Unmocked: ${cmd}`);
    });

    const result = gitUtils.getRepoInfo("/repo");
    expect(result).not.toBeNull();
    expect(result!.currentBranch).toBe("HEAD");
  });

  it("resolves default branch via origin HEAD", () => {
    mockGitCommands({
      "rev-parse --show-toplevel": "/repo",
      "rev-parse --abbrev-ref HEAD": "develop",
      "rev-parse --git-dir": ".git",
      "symbolic-ref refs/remotes/origin/HEAD": "refs/remotes/origin/develop",
    });

    const result = gitUtils.getRepoInfo("/repo");
    expect(result!.defaultBranch).toBe("develop");
  });

  it("falls back to 'main' when origin HEAD and master are unavailable", () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return "/repo";
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return "feature";
      if (cmd.includes("rev-parse --git-dir")) return ".git";
      if (cmd.includes("symbolic-ref refs/remotes/origin/HEAD")) throw new Error("no origin");
      if (cmd.includes("branch --list main master")) return "";
      throw new Error(`Unmocked: ${cmd}`);
    });

    const result = gitUtils.getRepoInfo("/repo");
    expect(result!.defaultBranch).toBe("main");
  });

  it("falls back to 'master' when origin HEAD fails and only master exists", () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return "/repo";
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return "feature";
      if (cmd.includes("rev-parse --git-dir")) return ".git";
      if (cmd.includes("symbolic-ref refs/remotes/origin/HEAD")) throw new Error("no origin");
      if (cmd.includes("branch --list main master")) return "  master";
      throw new Error(`Unmocked: ${cmd}`);
    });

    const result = gitUtils.getRepoInfo("/repo");
    expect(result!.defaultBranch).toBe("master");
  });

  it("resolves closest parent branch for worktree sessions", () => {
    // Worktree branch jiayi-wt-4719 was created from jiayi. The for-each-ref
    // --contains=HEAD command returns jiayi as a branch containing HEAD.
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return "/worktree/path";
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return "jiayi-wt-4719";
      if (cmd.includes("rev-parse --git-dir")) return "/repo/.git/worktrees/jiayi-wt-4719";
      if (cmd.includes("for-each-ref") && cmd.includes("--contains=HEAD")) return "jiayi\njiayi-wt-4719";
      if (cmd.includes("symbolic-ref refs/remotes/origin/HEAD")) throw new Error("no origin");
      throw new Error(`Unmocked: ${cmd}`);
    });

    const result = gitUtils.getRepoInfo("/worktree/path");
    expect(result!.defaultBranch).toBe("jiayi");
    expect(result!.isWorktree).toBe(true);
  });

  it("picks closest parent when multiple branches contain HEAD", () => {
    // Both jiayi and main contain HEAD, but jiayi is 1 commit ahead
    // while main is 100 commits ahead — jiayi is the closer parent.
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return "/repo";
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return "feat-branch";
      if (cmd.includes("rev-parse --git-dir")) return ".git";
      if (cmd.includes("for-each-ref") && cmd.includes("--contains=HEAD")) return "feat-branch\njiayi\nmain";
      if (cmd.includes("rev-list --count HEAD..jiayi")) return "1";
      if (cmd.includes("rev-list --count HEAD..main")) return "100";
      if (cmd.includes("symbolic-ref refs/remotes/origin/HEAD")) throw new Error("no origin");
      throw new Error(`Unmocked: ${cmd}`);
    });

    const result = gitUtils.getRepoInfo("/repo");
    expect(result!.defaultBranch).toBe("jiayi");
  });

  it("falls back to origin/HEAD when no parent branch found", () => {
    // No other branches contain HEAD → falls back to existing logic
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return "/repo";
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return "orphan-branch";
      if (cmd.includes("rev-parse --git-dir")) return ".git";
      if (cmd.includes("for-each-ref") && cmd.includes("--contains=HEAD")) return "orphan-branch";
      if (cmd.includes("symbolic-ref refs/remotes/origin/HEAD")) return "refs/remotes/origin/main";
      throw new Error(`Unmocked: ${cmd}`);
    });

    const result = gitUtils.getRepoInfo("/repo");
    expect(result!.defaultBranch).toBe("main");
  });
});

// ─── listBranches ────────────────────────────────────────────────────────────

describe("listBranches", () => {
  it("parses local branches with current marker", () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("worktree list --porcelain")) return "";
      if (cmd.includes("for-each-ref") && cmd.includes("refs/heads/")) {
        return "main\t*\nfeat/login\t ";
      }
      if (cmd.includes("for-each-ref") && cmd.includes("refs/remotes/origin/")) return "";
      if (cmd.includes("rev-list --left-right --count")) return "0\t0";
      throw new Error(`Unmocked: ${cmd}`);
    });

    const branches = gitUtils.listBranches("/repo");
    const main = branches.find((b) => b.name === "main");
    const feat = branches.find((b) => b.name === "feat/login");

    expect(main).toBeDefined();
    expect(main!.isCurrent).toBe(true);
    expect(main!.isRemote).toBe(false);

    expect(feat).toBeDefined();
    expect(feat!.isCurrent).toBe(false);
  });

  it("includes remote-only branches", () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("worktree list --porcelain")) return "";
      if (cmd.includes("for-each-ref") && cmd.includes("refs/heads/")) {
        return "main\t*";
      }
      if (cmd.includes("for-each-ref") && cmd.includes("refs/remotes/origin/")) {
        return "origin/feat/remote-branch";
      }
      if (cmd.includes("rev-list --left-right --count")) return "0\t0";
      throw new Error(`Unmocked: ${cmd}`);
    });

    const branches = gitUtils.listBranches("/repo");
    const remote = branches.find((b) => b.name === "feat/remote-branch");

    expect(remote).toBeDefined();
    expect(remote!.isRemote).toBe(true);
    expect(remote!.isCurrent).toBe(false);
    expect(remote!.ahead).toBe(0);
    expect(remote!.behind).toBe(0);
  });

  it("excludes origin/HEAD from remote branches", () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("worktree list --porcelain")) return "";
      if (cmd.includes("for-each-ref") && cmd.includes("refs/heads/")) return "";
      if (cmd.includes("for-each-ref") && cmd.includes("refs/remotes/origin/")) {
        return "origin/HEAD\norigin/main";
      }
      if (cmd.includes("rev-list --left-right --count")) return "0\t0";
      throw new Error(`Unmocked: ${cmd}`);
    });

    const branches = gitUtils.listBranches("/repo");
    expect(branches.find((b) => b.name === "HEAD")).toBeUndefined();
    expect(branches.find((b) => b.name === "main")).toBeDefined();
  });

  it("includes ahead/behind counts for local branches", () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("worktree list --porcelain")) return "";
      if (cmd.includes("for-each-ref") && cmd.includes("refs/heads/")) {
        return "dev\t ";
      }
      if (cmd.includes("for-each-ref") && cmd.includes("refs/remotes/origin/")) return "";
      if (cmd.includes("rev-list --left-right --count")) return "3\t5";
      throw new Error(`Unmocked: ${cmd}`);
    });

    const branches = gitUtils.listBranches("/repo");
    const dev = branches.find((b) => b.name === "dev");
    expect(dev).toBeDefined();
    // In the source: [behind, ahead] = raw.split(...).map(Number)
    expect(dev!.ahead).toBe(5);
    expect(dev!.behind).toBe(3);
  });

  it("returns empty array on git failure", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("git failed");
    });

    const branches = gitUtils.listBranches("/repo");
    expect(branches).toEqual([]);
  });
});

// ─── listWorktrees ───────────────────────────────────────────────────────────

describe("listWorktrees", () => {
  it("parses porcelain output correctly", () => {
    const porcelain = [
      "worktree /home/user/project",
      "HEAD abc1234567890abcdef1234567890abcdef123456",
      "branch refs/heads/main",
      "",
      "worktree /fake/home/.companion/worktrees/project/feat--x",
      "HEAD def4567890abcdef1234567890abcdef12345678",
      "branch refs/heads/feat/x",
      "",
    ].join("\n");

    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("worktree list --porcelain")) return porcelain;
      // isWorktreeDirty calls
      if (cmd.includes("status --porcelain")) return "";
      throw new Error(`Unmocked: ${cmd}`);
    });
    mockExistsSync.mockReturnValue(true);

    const worktrees = gitUtils.listWorktrees("/home/user/project");
    expect(worktrees).toHaveLength(2);
    expect(worktrees[0].path).toBe("/home/user/project");
    expect(worktrees[1].path).toBe("/fake/home/.companion/worktrees/project/feat--x");
  });

  it("marks first worktree as main", () => {
    const porcelain = [
      "worktree /home/user/project",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /tmp/wt",
      "HEAD def456",
      "branch refs/heads/other",
      "",
    ].join("\n");

    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("worktree list --porcelain")) return porcelain;
      if (cmd.includes("status --porcelain")) return "";
      throw new Error(`Unmocked: ${cmd}`);
    });
    mockExistsSync.mockReturnValue(true);

    const worktrees = gitUtils.listWorktrees("/home/user/project");
    expect(worktrees[0].isMainWorktree).toBe(true);
    expect(worktrees[1].isMainWorktree).toBe(false);
  });

  it("strips refs/heads/ from branch names", () => {
    const porcelain = [
      "worktree /repo",
      "HEAD abc123",
      "branch refs/heads/feat/something",
      "",
    ].join("\n");

    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("worktree list --porcelain")) return porcelain;
      if (cmd.includes("status --porcelain")) return "";
      throw new Error(`Unmocked: ${cmd}`);
    });
    mockExistsSync.mockReturnValue(true);

    const worktrees = gitUtils.listWorktrees("/repo");
    expect(worktrees[0].branch).toBe("feat/something");
  });

  it("returns empty array on failure", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("git failed");
    });

    const worktrees = gitUtils.listWorktrees("/repo");
    expect(worktrees).toEqual([]);
  });
});

// ─── ensureWorktree ──────────────────────────────────────────────────────────

describe("ensureWorktree", () => {
  it("returns existing worktree without creating a new one", () => {
    const porcelain = [
      "worktree /repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /existing/path",
      "HEAD def456",
      "branch refs/heads/feat/existing",
      "",
    ].join("\n");

    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("worktree list --porcelain")) return porcelain;
      if (cmd.includes("status --porcelain")) return "";
      throw new Error(`Unmocked: ${cmd}`);
    });
    mockExistsSync.mockReturnValue(true);

    const result = gitUtils.ensureWorktree("/repo", "feat/existing");
    expect(result.worktreePath).toBe("/existing/path");
    expect(result.branch).toBe("feat/existing");
    expect(result.actualBranch).toBe("feat/existing");
    expect(result.isNew).toBe(false);
    // Should NOT have called worktree add
    const addCalls = mockExecSync.mock.calls.filter((c: unknown[]) =>
      (c[0] as string).includes("worktree add"),
    );
    expect(addCalls).toHaveLength(0);
  });

  it("creates worktree with unique -wt- branch for an existing local branch", () => {
    mockExecSync.mockImplementation((cmd: string) => {
      // listWorktrees
      if (cmd.includes("worktree list --porcelain")) {
        return "worktree /repo\nHEAD abc\nbranch refs/heads/main\n";
      }
      if (cmd.includes("status --porcelain")) return "";
      // Branch exists locally
      if (cmd.includes("rev-parse --verify refs/heads/feat/local") && !cmd.includes("-wt-")) return "abc123";
      // rev-parse for the commit hash
      if (cmd.includes("rev-parse refs/heads/feat/local")) return "abc123";
      // generateUniqueWorktreeBranch checks (random suffix)
      if (/rev-parse --verify refs\/heads\/feat\/local-wt-\d{4}/.test(cmd)) throw new Error("not found");
      // worktree add -b
      if (cmd.includes("worktree add -b")) return "";
      throw new Error(`Unmocked: ${cmd}`);
    });
    // Target path doesn't exist yet
    mockExistsSync.mockReturnValue(false);

    const result = gitUtils.ensureWorktree("/repo", "feat/local");
    // Directory derived from unique branch name
    expect(result.worktreePath).toMatch(/^\/fake\/home\/\.companion\/worktrees\/repo\/feat--local-wt-\d{4}$/);
    expect(result.branch).toBe("feat/local");
    expect(result.actualBranch).toMatch(/^feat\/local-wt-\d{4}$/);
    expect(result.isNew).toBe(false);

    const addCall = mockExecSync.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes("worktree add -b"),
    );
    expect(addCall).toBeDefined();
    expect((addCall![0] as string)).toMatch(/feat\/local-wt-\d{4}/);
  });

  it("creates unique -wt- branch from remote", () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("worktree list --porcelain")) {
        return "worktree /repo\nHEAD abc\nbranch refs/heads/main\n";
      }
      if (cmd.includes("status --porcelain")) return "";
      // Local branch does NOT exist
      if (cmd.includes("rev-parse --verify refs/heads/feat/remote") && !cmd.includes("-wt-"))
        throw new Error("not found");
      // Remote branch exists
      if (cmd.includes("rev-parse --verify refs/remotes/origin/feat/remote"))
        return "def456";
      // generateUniqueWorktreeBranch checks (random suffix)
      if (/rev-parse --verify refs\/heads\/feat\/remote-wt-\d{4}/.test(cmd)) throw new Error("not found");
      // worktree add -b
      if (cmd.includes("worktree add -b")) return "";
      throw new Error(`Unmocked: ${cmd}`);
    });
    // Target path doesn't exist yet
    mockExistsSync.mockReturnValue(false);

    const result = gitUtils.ensureWorktree("/repo", "feat/remote");
    expect(result.branch).toBe("feat/remote");
    expect(result.actualBranch).toMatch(/^feat\/remote-wt-\d{4}$/);
    expect(result.isNew).toBe(false);

    const addCall = mockExecSync.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes("worktree add -b"),
    );
    expect(addCall).toBeDefined();
    expect((addCall![0] as string)).toContain("origin/feat/remote");
    expect((addCall![0] as string)).toMatch(/feat\/remote-wt-\d{4}/);
  });

  it("creates unique -wt- branch from base when branch does not exist anywhere", () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("worktree list --porcelain")) {
        return "worktree /repo\nHEAD abc\nbranch refs/heads/main\n";
      }
      if (cmd.includes("status --porcelain")) return "";
      // Neither local nor remote branch exists
      if (cmd.includes("rev-parse --verify")) throw new Error("not found");
      // resolveDefaultBranch — not needed since baseBranch is explicit
      if (cmd.includes("symbolic-ref refs/remotes/origin/HEAD"))
        return "refs/remotes/origin/main";
      // worktree add -b
      if (cmd.includes("worktree add -b")) return "";
      throw new Error(`Unmocked: ${cmd}`);
    });
    // Target path doesn't exist yet
    mockExistsSync.mockReturnValue(false);

    const result = gitUtils.ensureWorktree("/repo", "feat/new", { baseBranch: "develop" });
    expect(result.isNew).toBe(true);
    expect(result.branch).toBe("feat/new");
    expect(result.actualBranch).toMatch(/^feat\/new-wt-\d{4}$/);

    const addCall = mockExecSync.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes("worktree add -b"),
    );
    expect(addCall).toBeDefined();
    expect((addCall![0] as string)).toContain("develop");
    expect((addCall![0] as string)).toMatch(/feat\/new-wt-\d{4}/);
  });

  it("throws when createBranch=false and branch does not exist", () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("worktree list --porcelain")) {
        return "worktree /repo\nHEAD abc\nbranch refs/heads/main\n";
      }
      if (cmd.includes("status --porcelain")) return "";
      if (cmd.includes("rev-parse --verify")) throw new Error("not found");
      throw new Error(`Unmocked: ${cmd}`);
    });
    // Target path doesn't exist yet
    mockExistsSync.mockReturnValue(false);

    expect(() =>
      gitUtils.ensureWorktree("/repo", "feat/missing", { createBranch: false }),
    ).toThrow('Branch "feat/missing" does not exist and createBranch is false');
  });

  it("calls mkdirSync with recursive option when creating worktree", () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("worktree list --porcelain")) {
        return "worktree /repo\nHEAD abc\nbranch refs/heads/main\n";
      }
      if (cmd.includes("status --porcelain")) return "";
      if (cmd.includes("rev-parse --verify refs/heads/feat/new") && !cmd.includes("-wt-")) return "abc";
      if (cmd.includes("rev-parse refs/heads/feat/new")) return "abc";
      // generateUniqueWorktreeBranch checks
      if (/rev-parse --verify refs\/heads\/feat\/new-wt-\d{4}/.test(cmd)) throw new Error("not found");
      if (cmd.includes("worktree add")) return "";
      throw new Error(`Unmocked: ${cmd}`);
    });
    // Target path doesn't exist yet
    mockExistsSync.mockReturnValue(false);

    gitUtils.ensureWorktree("/repo", "feat/new");

    expect(mockMkdirSync).toHaveBeenCalledWith(
      "/fake/home/.companion/worktrees/repo",
      { recursive: true },
    );
  });

  it("does not reuse the main worktree even when branch matches", () => {
    // Main worktree is on "main", and we request a worktree for "main"
    const porcelain = [
      "worktree /repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
    ].join("\n");

    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("worktree list --porcelain")) return porcelain;
      if (cmd.includes("status --porcelain")) return "";
      if (cmd.includes("rev-parse HEAD")) return "abc123";
      // generateUniqueWorktreeBranch checks for existing branches (random suffix)
      if (/rev-parse --verify refs\/heads\/main-wt-\d{4}/.test(cmd)) throw new Error("not found");
      if (cmd.includes("worktree add -b")) return "";
      throw new Error(`Unmocked: ${cmd}`);
    });
    // Target path doesn't exist yet
    mockExistsSync.mockReturnValue(false);

    const result = gitUtils.ensureWorktree("/repo", "main");
    // Should NOT return the main repo path
    expect(result.worktreePath).not.toBe("/repo");
    // Directory is derived from the unique branch name so both share the same suffix
    expect(result.worktreePath).toMatch(/^\/fake\/home\/\.companion\/worktrees\/repo\/main-wt-\d{4}$/);
    expect(result.branch).toBe("main");
    expect(result.actualBranch).toMatch(/^main-wt-\d{4}$/);
    // Should create a branch-tracking worktree
    const addCall = mockExecSync.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes("worktree add -b"),
    );
    expect(addCall).toBeDefined();
    expect((addCall![0] as string)).toMatch(/main-wt-\d{4}/);
    expect((addCall![0] as string)).toContain("abc123");
  });

  it("always creates unique -wt- branch even for first worktree on a branch", () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("worktree list --porcelain")) {
        return "worktree /repo\nHEAD abc\nbranch refs/heads/main\n";
      }
      if (cmd.includes("status --porcelain")) return "";
      if (cmd.includes("rev-parse --verify refs/heads/feat/x") && !cmd.includes("-wt-")) return "abc123";
      if (cmd.includes("rev-parse refs/heads/feat/x")) return "abc123";
      // generateUniqueWorktreeBranch checks
      if (/rev-parse --verify refs\/heads\/feat\/x-wt-\d{4}/.test(cmd)) throw new Error("not found");
      if (cmd.includes("worktree add -b")) return "";
      throw new Error(`Unmocked: ${cmd}`);
    });
    mockExistsSync.mockReturnValue(false);

    const result = gitUtils.ensureWorktree("/repo", "feat/x");
    // Directory and branch both use -wt-XXXX suffix
    expect(result.worktreePath).toMatch(/^\/fake\/home\/\.companion\/worktrees\/repo\/feat--x-wt-\d{4}$/);
    expect(result.branch).toBe("feat/x");
    expect(result.actualBranch).toMatch(/^feat\/x-wt-\d{4}$/);
  });

  it("creates branch-tracking worktree when forceNew=true and worktree already exists", () => {
    const porcelain = [
      "worktree /repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /existing/wt",
      "HEAD def456",
      "branch refs/heads/feat/existing",
      "",
    ].join("\n");

    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("worktree list --porcelain")) return porcelain;
      if (cmd.includes("status --porcelain")) return "";
      if (cmd.includes("rev-parse HEAD")) return "def456";
      // generateUniqueWorktreeBranch checks (random suffix)
      if (/rev-parse --verify refs\/heads\/feat\/existing-wt-\d{4}/.test(cmd)) throw new Error("not found");
      if (cmd.includes("worktree add -b")) return "";
      throw new Error(`Unmocked: ${cmd}`);
    });
    // Target path doesn't exist yet
    mockExistsSync.mockReturnValue(false);

    const result = gitUtils.ensureWorktree("/repo", "feat/existing", { forceNew: true });
    // Directory derived from unique branch name — both share the same suffix
    expect(result.worktreePath).toMatch(/^\/fake\/home\/\.companion\/worktrees\/repo\/feat--existing-wt-\d{4}$/);
    expect(result.branch).toBe("feat/existing");
    expect(result.actualBranch).toMatch(/^feat\/existing-wt-\d{4}$/);

    const addCall = mockExecSync.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes("worktree add -b"),
    );
    expect(addCall).toBeDefined();
    expect((addCall![0] as string)).toMatch(/feat\/existing-wt-\d{4}/);
  });

  it("generates unique branch when forceNew=true and branch exists locally but no worktree uses it", () => {
    // Main repo is on a different branch (feat/other), not on "main"
    const porcelain = [
      "worktree /repo",
      "HEAD abc123",
      "branch refs/heads/feat/other",
      "",
    ].join("\n");

    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("worktree list --porcelain")) return porcelain;
      if (cmd.includes("status --porcelain")) return "";
      // "main" exists as a local branch
      if (cmd.includes("rev-parse --verify refs/heads/main") && !cmd.includes("-wt-")) return "aaa111";
      // rev-parse for the commit hash (git() uses cwd, not -C)
      if (cmd === "git rev-parse refs/heads/main") return "aaa111";
      // generateUniqueWorktreeBranch checks (random suffix)
      if (/rev-parse --verify refs\/heads\/main-wt-\d{4}/.test(cmd)) throw new Error("not found");
      if (cmd.includes("worktree add -b")) return "";
      throw new Error(`Unmocked: ${cmd}`);
    });
    mockExistsSync.mockReturnValue(false);

    const result = gitUtils.ensureWorktree("/repo", "main", { forceNew: true });
    // Directory derived from unique branch name — both share the same suffix
    expect(result.worktreePath).toMatch(/^\/fake\/home\/\.companion\/worktrees\/repo\/main-wt-\d{4}$/);
    expect(result.branch).toBe("main");
    // Should get a unique branch, NOT the raw "main" branch
    expect(result.actualBranch).toMatch(/^main-wt-\d{4}$/);

    const addCall = mockExecSync.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes("worktree add -b"),
    );
    expect(addCall).toBeDefined();
    expect((addCall![0] as string)).toMatch(/main-wt-\d{4}/);
  });

  it("generates unique branch when forceNew=true and only remote branch exists", () => {
    // No worktree on "main", main repo on different branch
    const porcelain = [
      "worktree /repo",
      "HEAD abc123",
      "branch refs/heads/feat/other",
      "",
    ].join("\n");

    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("worktree list --porcelain")) return porcelain;
      if (cmd.includes("status --porcelain")) return "";
      // "main" does NOT exist locally
      if (cmd.includes("rev-parse --verify refs/heads/main") && !cmd.includes("-wt-") && !cmd.includes("remotes")) throw new Error("not found");
      // "main" exists on remote
      if (cmd.includes("rev-parse --verify refs/remotes/origin/main")) return "bbb222";
      // generateUniqueWorktreeBranch checks
      if (/rev-parse --verify refs\/heads\/main-wt-\d{4}/.test(cmd)) throw new Error("not found");
      if (cmd.includes("worktree add -b")) return "";
      throw new Error(`Unmocked: ${cmd}`);
    });
    mockExistsSync.mockReturnValue(false);

    const result = gitUtils.ensureWorktree("/repo", "main", { forceNew: true });
    expect(result.branch).toBe("main");
    expect(result.actualBranch).toMatch(/^main-wt-\d{4}$/);

    const addCall = mockExecSync.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes("worktree add -b"),
    );
    expect(addCall).toBeDefined();
    expect((addCall![0] as string)).toMatch(/main-wt-\d{4}/);
    expect((addCall![0] as string)).toContain("origin/main");
  });
});

// ─── generateUniqueWorktreeBranch ────────────────────────────────────────────

describe("generateUniqueWorktreeBranch", () => {
  it("returns branch-wt-{random4digit} when no suffixed branches exist", () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --verify refs/heads/main-wt-")) throw new Error("not found");
      throw new Error(`Unmocked: ${cmd}`);
    });

    const result = gitUtils.generateUniqueWorktreeBranch("/repo", "main");
    expect(result).toMatch(/^main-wt-\d{4}$/);
  });

  it("retries with a new random suffix on collision", () => {
    // Mock Math.random to return deterministic values
    const origRandom = Math.random;
    const randomValues = [0.5, 0.7]; // → suffixes 5500, 7300
    let callIdx = 0;
    Math.random = () => randomValues[callIdx++] ?? origRandom();

    mockExecSync.mockImplementation((cmd: string) => {
      // First candidate (5500) already exists
      if (cmd.includes("rev-parse --verify refs/heads/feat/x-wt-5500")) return "abc";
      // Second candidate (7300) is free
      if (cmd.includes("rev-parse --verify refs/heads/feat/x-wt-7300")) throw new Error("not found");
      throw new Error(`Unmocked: ${cmd}`);
    });

    const result = gitUtils.generateUniqueWorktreeBranch("/repo", "feat/x");
    expect(result).toBe("feat/x-wt-7300");

    Math.random = origRandom;
  });
});

// ─── removeWorktree ──────────────────────────────────────────────────────────

describe("removeWorktree", () => {
  it("prunes when worktree path does not exist on disk", () => {
    mockExistsSync.mockReturnValue(false);
    mockGitCommand("worktree prune", "");

    const result = gitUtils.removeWorktree("/repo", "/gone/path");
    expect(result.removed).toBe(true);
    expect(result.reason).toBeUndefined();

    const pruneCalls = mockExecSync.mock.calls.filter((c: unknown[]) =>
      (c[0] as string).includes("worktree prune"),
    );
    expect(pruneCalls).toHaveLength(1);
  });

  it("deletes branchToDelete after pruning a missing worktree", () => {
    mockExistsSync.mockReturnValue(false);
    mockGitCommands({
      "worktree prune": "",
      "branch -D main-wt-2": "",
    });

    const result = gitUtils.removeWorktree("/repo", "/gone/path", { branchToDelete: "main-wt-2" });
    expect(result.removed).toBe(true);

    const branchDeleteCalls = mockExecSync.mock.calls.filter((c: unknown[]) =>
      (c[0] as string).includes("branch -D main-wt-2"),
    );
    expect(branchDeleteCalls).toHaveLength(1);
  });

  it("deletes branchToDelete after successful worktree removal", () => {
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("status --porcelain")) return "";
      if (cmd.includes("worktree remove")) return "";
      if (cmd.includes("branch -D feat-wt-3")) return "";
      throw new Error(`Unmocked: ${cmd}`);
    });

    const result = gitUtils.removeWorktree("/repo", "/wt/path", { branchToDelete: "feat-wt-3" });
    expect(result.removed).toBe(true);

    const branchDeleteCalls = mockExecSync.mock.calls.filter((c: unknown[]) =>
      (c[0] as string).includes("branch -D feat-wt-3"),
    );
    expect(branchDeleteCalls).toHaveLength(1);
  });

  it("refuses to remove dirty worktree without force", () => {
    mockExistsSync.mockReturnValue(true);
    mockGitCommand("status --porcelain", " M dirty-file.ts");

    const result = gitUtils.removeWorktree("/repo", "/wt/path");
    expect(result.removed).toBe(false);
    expect(result.reason).toContain("uncommitted changes");
  });

  it("force-removes dirty worktree", () => {
    // existsSync: first call for removeWorktree check, second for isWorktreeDirty
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("status --porcelain")) return " M dirty.ts";
      if (cmd.includes("worktree remove") && cmd.includes("--force")) return "";
      throw new Error(`Unmocked: ${cmd}`);
    });

    const result = gitUtils.removeWorktree("/repo", "/wt/path", { force: true });
    expect(result.removed).toBe(true);
  });

  it("returns reason on error during removal", () => {
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("status --porcelain")) return "";
      if (cmd.includes("worktree remove"))
        throw new Error("worktree is locked");
      throw new Error(`Unmocked: ${cmd}`);
    });

    const result = gitUtils.removeWorktree("/repo", "/wt/path");
    expect(result.removed).toBe(false);
    expect(result.reason).toContain("worktree is locked");
  });
});

// ─── isWorktreeDirty ─────────────────────────────────────────────────────────

describe("isWorktreeDirty", () => {
  it("returns false when path does not exist", () => {
    mockExistsSync.mockReturnValue(false);

    expect(gitUtils.isWorktreeDirty("/nonexistent")).toBe(false);
  });

  it("returns false when status is empty", () => {
    mockExistsSync.mockReturnValue(true);
    mockGitCommand("status --porcelain", "");

    expect(gitUtils.isWorktreeDirty("/clean/repo")).toBe(false);
  });

  it("returns true when status has output", () => {
    mockExistsSync.mockReturnValue(true);
    mockGitCommand("status --porcelain", " M file.ts\n?? new-file.ts");

    expect(gitUtils.isWorktreeDirty("/dirty/repo")).toBe(true);
  });
});

// ─── getBranchStatus ─────────────────────────────────────────────────────────

describe("getBranchStatus", () => {
  it("parses ahead/behind counts correctly", () => {
    mockGitCommand("rev-list --left-right --count", "7\t12");

    const status = gitUtils.getBranchStatus("/repo", "feat/branch");
    // Source: [behind, ahead] = raw.split(...).map(Number)
    expect(status.ahead).toBe(12);
    expect(status.behind).toBe(7);
  });

  it("returns 0/0 when there is no upstream", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("no upstream configured");
    });

    const status = gitUtils.getBranchStatus("/repo", "local-only");
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
  });

  it("handles zero ahead/behind", () => {
    mockGitCommand("rev-list --left-right --count", "0\t0");

    const status = gitUtils.getBranchStatus("/repo", "main");
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
  });
});

// ─── resolveDefaultBranchAsync ──────────────────────────────────────────────

describe("resolveDefaultBranchAsync", () => {
  it("resolves default branch via origin HEAD", async () => {
    mockAsyncGitCommands({
      // findClosestParentBranchAsync: for-each-ref returns only current branch → no parent
      "for-each-ref": "develop",
      "symbolic-ref refs/remotes/origin/HEAD": "refs/remotes/origin/develop",
    });

    const result = await gitUtils.resolveDefaultBranchAsync("/repo", "develop");
    expect(result).toBe("develop");
  });

  it("falls back to 'main' when origin HEAD and master are unavailable", async () => {
    mockExecCb.mockImplementation((cmd: string, _opts: unknown, cb: Function) => {
      if (cmd.includes("for-each-ref")) {
        // Only the current branch itself — no parent candidates
        cb(null, { stdout: "feature\n", stderr: "" });
      } else if (cmd.includes("symbolic-ref refs/remotes/origin/HEAD")) {
        cb(new Error("no origin"), { stdout: "", stderr: "" });
      } else if (cmd.includes("branch --list main master")) {
        cb(null, { stdout: "\n", stderr: "" });
      } else {
        cb(new Error(`Unmocked async: ${cmd}`), { stdout: "", stderr: "" });
      }
    });

    const result = await gitUtils.resolveDefaultBranchAsync("/repo", "feature");
    expect(result).toBe("main");
  });

  it("falls back to 'master' when origin HEAD fails and only master exists", async () => {
    mockExecCb.mockImplementation((cmd: string, _opts: unknown, cb: Function) => {
      if (cmd.includes("for-each-ref")) {
        cb(null, { stdout: "feature\n", stderr: "" });
      } else if (cmd.includes("symbolic-ref refs/remotes/origin/HEAD")) {
        cb(new Error("no origin"), { stdout: "", stderr: "" });
      } else if (cmd.includes("branch --list main master")) {
        cb(null, { stdout: "  master\n", stderr: "" });
      } else {
        cb(new Error(`Unmocked async: ${cmd}`), { stdout: "", stderr: "" });
      }
    });

    const result = await gitUtils.resolveDefaultBranchAsync("/repo", "feature");
    expect(result).toBe("master");
  });

  it("resolves closest parent branch for worktree sessions", async () => {
    // Worktree branch jiayi-wt-4719 was created from jiayi. The for-each-ref
    // --contains=HEAD command returns jiayi as a branch containing HEAD.
    mockExecCb.mockImplementation((cmd: string, _opts: unknown, cb: Function) => {
      if (cmd.includes("for-each-ref") && cmd.includes("--contains=HEAD")) {
        cb(null, { stdout: "jiayi\njiayi-wt-4719\n", stderr: "" });
      } else if (cmd.includes("symbolic-ref refs/remotes/origin/HEAD")) {
        cb(new Error("no origin"), { stdout: "", stderr: "" });
      } else {
        cb(new Error(`Unmocked async: ${cmd}`), { stdout: "", stderr: "" });
      }
    });

    const result = await gitUtils.resolveDefaultBranchAsync("/repo", "jiayi-wt-4719");
    expect(result).toBe("jiayi");
  });

  it("uses fast-path name match for worktree branches (e.g. jiayi-wt-4719 → jiayi)", async () => {
    // The async version has a fast path: if the branch name matches /^(.+)-wt-\d+$/,
    // check if the parent branch exists without running for-each-ref.
    mockExecCb.mockImplementation((cmd: string, _opts: unknown, cb: Function) => {
      if (cmd.includes("rev-parse --verify refs/heads/jiayi")) {
        cb(null, { stdout: "abc123\n", stderr: "" });
      } else {
        cb(new Error(`Unmocked async: ${cmd}`), { stdout: "", stderr: "" });
      }
    });

    const result = await gitUtils.resolveDefaultBranchAsync("/repo", "jiayi-wt-4719");
    expect(result).toBe("jiayi");
    // Should NOT have called for-each-ref since fast path succeeded
    const forEachRefCalls = mockExecCb.mock.calls.filter((c: unknown[]) =>
      (c[0] as string).includes("for-each-ref"),
    );
    expect(forEachRefCalls).toHaveLength(0);
  });

  it("picks closest parent when multiple branches contain HEAD", async () => {
    // Both jiayi and main contain HEAD, but jiayi is 1 commit ahead
    // while main is 100 commits ahead — jiayi is the closer parent.
    mockExecCb.mockImplementation((cmd: string, _opts: unknown, cb: Function) => {
      if (cmd.includes("for-each-ref") && cmd.includes("--contains=HEAD")) {
        cb(null, { stdout: "feat-branch\njiayi\nmain\n", stderr: "" });
      } else if (cmd.includes("rev-list --count HEAD..jiayi")) {
        cb(null, { stdout: "1\n", stderr: "" });
      } else if (cmd.includes("rev-list --count HEAD..main")) {
        cb(null, { stdout: "100\n", stderr: "" });
      } else if (cmd.includes("symbolic-ref refs/remotes/origin/HEAD")) {
        cb(new Error("no origin"), { stdout: "", stderr: "" });
      } else {
        cb(new Error(`Unmocked async: ${cmd}`), { stdout: "", stderr: "" });
      }
    });

    const result = await gitUtils.resolveDefaultBranchAsync("/repo", "feat-branch");
    expect(result).toBe("jiayi");
  });

  it("falls back to origin/HEAD when no parent branch found", async () => {
    // No other branches contain HEAD → falls back to origin/HEAD
    mockExecCb.mockImplementation((cmd: string, _opts: unknown, cb: Function) => {
      if (cmd.includes("for-each-ref") && cmd.includes("--contains=HEAD")) {
        cb(null, { stdout: "orphan-branch\n", stderr: "" });
      } else if (cmd.includes("symbolic-ref refs/remotes/origin/HEAD")) {
        cb(null, { stdout: "refs/remotes/origin/main\n", stderr: "" });
      } else {
        cb(new Error(`Unmocked async: ${cmd}`), { stdout: "", stderr: "" });
      }
    });

    const result = await gitUtils.resolveDefaultBranchAsync("/repo", "orphan-branch");
    expect(result).toBe("main");
  });

  it("returns 'main' when no currentBranch is provided and origin/HEAD fails", async () => {
    mockExecCb.mockImplementation((cmd: string, _opts: unknown, cb: Function) => {
      if (cmd.includes("symbolic-ref refs/remotes/origin/HEAD")) {
        cb(new Error("no origin"), { stdout: "", stderr: "" });
      } else if (cmd.includes("branch --list main master")) {
        cb(null, { stdout: "\n", stderr: "" });
      } else {
        cb(new Error(`Unmocked async: ${cmd}`), { stdout: "", stderr: "" });
      }
    });

    // No currentBranch — skips findClosestParentBranchAsync entirely
    const result = await gitUtils.resolveDefaultBranchAsync("/repo");
    expect(result).toBe("main");
  });

  it("skips parent branch search when currentBranch is 'HEAD' (detached)", async () => {
    mockExecCb.mockImplementation((cmd: string, _opts: unknown, cb: Function) => {
      if (cmd.includes("symbolic-ref refs/remotes/origin/HEAD")) {
        cb(null, { stdout: "refs/remotes/origin/main\n", stderr: "" });
      } else {
        cb(new Error(`Unmocked async: ${cmd}`), { stdout: "", stderr: "" });
      }
    });

    const result = await gitUtils.resolveDefaultBranchAsync("/repo", "HEAD");
    expect(result).toBe("main");
    // Should NOT have called for-each-ref since HEAD is excluded
    const forEachRefCalls = mockExecCb.mock.calls.filter((c: unknown[]) =>
      (c[0] as string).includes("for-each-ref"),
    );
    expect(forEachRefCalls).toHaveLength(0);
  });
});
