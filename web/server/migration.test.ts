import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  rewritePathsInFile,
  rewritePathsInDir,
  recreateWorktreeIfMissing,
  cwdToProjectDir,
  migrateClaudeProjectDir,
} from "./migration.js";
import * as gitUtils from "./git-utils.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  const dir = join(tmpdir(), `companion-migration-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── rewritePathsInFile ────────────────────────────────────────────────────

describe("rewritePathsInFile", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true });
  });

  it("is a no-op when oldHome === newHome", () => {
    const filePath = join(tempDir, "test.json");
    const content = JSON.stringify({ cwd: "/home/alice/.companion/worktrees/repo/branch" });
    writeFileSync(filePath, content, "utf-8");

    rewritePathsInFile(filePath, "/home/alice", "/home/alice");

    expect(readFileSync(filePath, "utf-8")).toBe(content);
  });

  it("rewrites paths from old home to new home", () => {
    const filePath = join(tempDir, "test.json");
    const original = JSON.stringify({
      cwd: "/home/olduser/.companion/worktrees/repo/branch-wt-1234",
      repo_root: "/home/olduser/myrepo",
    });
    writeFileSync(filePath, original, "utf-8");

    rewritePathsInFile(filePath, "/home/olduser", "/home/newuser");

    const result = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(result.cwd).toBe("/home/newuser/.companion/worktrees/repo/branch-wt-1234");
    expect(result.repo_root).toBe("/home/newuser/myrepo");
  });

  it("does not false-match prefix-sharing paths", () => {
    // /home/jiayi should NOT match /home/jiayiwei because we use trailing-slash matching
    const filePath = join(tempDir, "test.json");
    const original = JSON.stringify({
      cwd: "/home/jiayiwei/.companion/worktrees/repo/branch",
      other: "/home/jiayi/.companion/worktrees/repo/branch",
    });
    writeFileSync(filePath, original, "utf-8");

    rewritePathsInFile(filePath, "/home/jiayi", "/home/bob");

    const result = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(result.cwd).toBe("/home/jiayiwei/.companion/worktrees/repo/branch");
    expect(result.other).toBe("/home/bob/.companion/worktrees/repo/branch");
  });

  it("handles paths at end of JSON string values (no trailing slash)", () => {
    const filePath = join(tempDir, "test.json");
    const original = JSON.stringify({ repoRoot: "/home/olduser" });
    writeFileSync(filePath, original, "utf-8");

    rewritePathsInFile(filePath, "/home/olduser", "/home/newuser");

    const result = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(result.repoRoot).toBe("/home/newuser");
  });

  it("handles paths in arrays (e.g. changedFiles)", () => {
    const filePath = join(tempDir, "test.json");
    const original = JSON.stringify({
      changedFiles: ["/home/olduser/repo/src/foo.ts", "/home/olduser/repo/src/bar.ts"],
    });
    writeFileSync(filePath, original, "utf-8");

    rewritePathsInFile(filePath, "/home/olduser", "/Users/newuser");

    const result = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(result.changedFiles).toEqual(["/Users/newuser/repo/src/foo.ts", "/Users/newuser/repo/src/bar.ts"]);
  });

  it("handles macOS to Linux migration", () => {
    const filePath = join(tempDir, "test.json");
    const original = JSON.stringify({
      cwd: "/Users/alice/.companion/worktrees/repo/branch",
    });
    writeFileSync(filePath, original, "utf-8");

    rewritePathsInFile(filePath, "/Users/alice", "/home/alice");

    const result = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(result.cwd).toBe("/home/alice/.companion/worktrees/repo/branch");
  });
});

// ─── rewritePathsInDir ─────────────────────────────────────────────────────

describe("rewritePathsInDir", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true });
  });

  it("recursively rewrites JSON files in subdirectories", () => {
    mkdirSync(join(tempDir, "sessions", "3456"), { recursive: true });
    writeFileSync(
      join(tempDir, "sessions", "3456", "abc.json"),
      JSON.stringify({ state: { cwd: "/home/old/repo" } }),
      "utf-8",
    );
    writeFileSync(
      join(tempDir, "worktrees.json"),
      JSON.stringify([{ repoRoot: "/home/old/repo", worktreePath: "/home/old/.companion/worktrees/r/b" }]),
      "utf-8",
    );

    rewritePathsInDir(tempDir, "/home/old", "/home/new");

    const session = JSON.parse(readFileSync(join(tempDir, "sessions", "3456", "abc.json"), "utf-8"));
    expect(session.state.cwd).toBe("/home/new/repo");

    const worktrees = JSON.parse(readFileSync(join(tempDir, "worktrees.json"), "utf-8"));
    expect(worktrees[0].repoRoot).toBe("/home/new/repo");
    expect(worktrees[0].worktreePath).toBe("/home/new/.companion/worktrees/r/b");
  });

  it("skips non-JSON files", () => {
    const imgPath = join(tempDir, "thumb.jpeg");
    writeFileSync(imgPath, "binary content /home/old/path here", "utf-8");

    rewritePathsInDir(tempDir, "/home/old", "/home/new");

    expect(readFileSync(imgPath, "utf-8")).toBe("binary content /home/old/path here");
  });
});

// ─── cwdToProjectDir ────────────────────────────────────────────────────────

describe("cwdToProjectDir", () => {
  it("converts a standard Linux path", () => {
    expect(cwdToProjectDir("/home/jiayiwei/companion")).toBe("-home-jiayiwei-companion");
  });

  it("handles dotfiles in paths (double dash from / + .)", () => {
    expect(cwdToProjectDir("/home/jiayiwei/.companion/worktrees/companion/jiayi-9104")).toBe(
      "-home-jiayiwei--companion-worktrees-companion-jiayi-9104",
    );
  });

  it("handles macOS paths", () => {
    expect(cwdToProjectDir("/Users/alice/projects/myapp")).toBe("-Users-alice-projects-myapp");
  });

  it("preserves dashes in directory names", () => {
    expect(cwdToProjectDir("/home/user/my-project")).toBe("-home-user-my-project");
  });
});

// ─── rewritePathsInDir with JSONL ──────────────────────────────────────────

describe("rewritePathsInDir with JSONL files", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true });
  });

  it("rewrites paths in .jsonl files", () => {
    const jsonlPath = join(tempDir, "session.jsonl");
    const lines = [
      JSON.stringify({ type: "enqueue", content: "check /home/old/repo/file.ts" }),
      JSON.stringify({ type: "tool_use", input: { file_path: "/home/old/repo/src/main.ts" } }),
    ];
    writeFileSync(jsonlPath, lines.join("\n"), "utf-8");

    rewritePathsInDir(tempDir, "/home/old", "/home/new");

    const result = readFileSync(jsonlPath, "utf-8");
    expect(result).toContain("/home/new/repo/file.ts");
    expect(result).toContain("/home/new/repo/src/main.ts");
    expect(result).not.toContain("/home/old");
  });
});

// ─── recreateWorktreeIfMissing ──────────────────────────────────────────────

describe("recreateWorktreeIfMissing", () => {
  it("returns recreated: false if cwd exists", async () => {
    const tempDir = makeTempDir();
    try {
      const info = {
        sessionId: "test-session",
        cwd: tempDir,
        state: "exited" as const,
        createdAt: Date.now(),
        isWorktree: true,
        repoRoot: "/some/repo",
        branch: "main",
      };

      const mockDeps = {
        launcher: { updateWorktree: () => {} } as any,
        worktreeTracker: { addMapping: () => {} } as any,
        wsBridge: { markWorktree: () => {} } as any,
      };

      const result = await recreateWorktreeIfMissing("test-session", info, mockDeps);
      expect(result.recreated).toBe(false);
      expect(result.error).toBeUndefined();
    } finally {
      rmSync(tempDir, { recursive: true });
    }
  });

  it("returns error for non-worktree session with missing cwd", async () => {
    const info = {
      sessionId: "test-session",
      cwd: "/nonexistent/path/that/does/not/exist",
      state: "exited" as const,
      createdAt: Date.now(),
      isWorktree: false,
    };

    const mockDeps = {
      launcher: { updateWorktree: () => {} } as any,
      worktreeTracker: { addMapping: () => {} } as any,
      wsBridge: { markWorktree: () => {} } as any,
    };

    const result = await recreateWorktreeIfMissing("test-session", info, mockDeps);
    expect(result.recreated).toBe(false);
    expect(result.error).toContain("Working directory not found");
  });

  it("returns error when repo root doesn't exist", async () => {
    const info = {
      sessionId: "test-session",
      cwd: "/nonexistent/worktree/path",
      state: "exited" as const,
      createdAt: Date.now(),
      isWorktree: true,
      repoRoot: "/nonexistent/repo/root",
      branch: "main",
    };

    const mockDeps = {
      launcher: { updateWorktree: () => {} } as any,
      worktreeTracker: { addMapping: () => {} } as any,
      wsBridge: { markWorktree: () => {} } as any,
    };

    const result = await recreateWorktreeIfMissing("test-session", info, mockDeps);
    expect(result.recreated).toBe(false);
    expect(result.error).toContain("Repository not found");
    expect(result.error).toContain("Please clone it first");
  });
  it("restores worktree from archived ref when it exists (q-329)", async () => {
    // When a worktree session is unarchived, recreateWorktreeIfMissing should
    // restore the branch from its archived ref (refs/companion/archived/) and
    // create a worktree on it, preserving committed work.
    const info = {
      sessionId: "test-session",
      cwd: "/nonexistent/worktree/jiayi-wt-8153",
      state: "exited" as const,
      createdAt: Date.now(),
      isWorktree: true,
      repoRoot: "/tmp/test-repo",
      branch: "jiayi",
      actualBranch: "jiayi-wt-8153",
    };

    const updateWorktree = vi.fn();
    const addMapping = vi.fn();
    const markWorktree = vi.fn();
    const mockDeps = {
      launcher: { updateWorktree } as any,
      worktreeTracker: { addMapping } as any,
      wsBridge: { markWorktree } as any,
    };

    // Mock: repo exists, archived ref exists and is restored
    const getRepoInfoSpy = vi.spyOn(gitUtils, "getRepoInfoAsync").mockResolvedValue({
      repoRoot: "/tmp/test-repo",
      repoName: "test-repo",
      currentBranch: "jiayi",
      defaultBranch: "main",
      isWorktree: false,
    });
    const restoreRefSpy = vi.spyOn(gitUtils, "restoreArchivedBranchAsync").mockResolvedValue("abc123");
    const gitAsyncSpy = vi.spyOn(gitUtils, "gitAsync").mockResolvedValue("");

    try {
      const result = await recreateWorktreeIfMissing("test-session", info, mockDeps);

      expect(result.recreated).toBe(true);
      expect(result.error).toBeUndefined();

      // Should have tried to restore the archived ref
      expect(restoreRefSpy).toHaveBeenCalledWith("/tmp/test-repo", "jiayi-wt-8153");

      // Should have created worktree on the restored branch (no -b flag)
      const worktreeAddCmd = gitAsyncSpy.mock.calls.find(
        ([cmd]) => typeof cmd === "string" && cmd.includes("worktree add"),
      );
      expect(worktreeAddCmd?.[0]).toContain("jiayi-wt-8153");
      expect(worktreeAddCmd?.[0]).not.toContain("-b");

      // Should have updated launcher with the original branch
      expect(updateWorktree).toHaveBeenCalledWith("test-session", {
        cwd: expect.any(String),
        actualBranch: "jiayi-wt-8153",
      });
    } finally {
      getRepoInfoSpy.mockRestore();
      restoreRefSpy.mockRestore();
      gitAsyncSpy.mockRestore();
    }
  });

  it("falls back to fresh branch when no archived ref exists (q-329)", async () => {
    // If no archived ref exists (branch was manually deleted, or session was
    // archived before the ref feature existed), fall back to fresh worktree.
    const info = {
      sessionId: "test-session",
      cwd: "/nonexistent/worktree/jiayi-wt-9999",
      state: "exited" as const,
      createdAt: Date.now(),
      isWorktree: true,
      repoRoot: "/tmp/test-repo",
      branch: "jiayi",
      actualBranch: "jiayi-wt-9999",
    };

    const mockDeps = {
      launcher: { updateWorktree: vi.fn() } as any,
      worktreeTracker: { addMapping: vi.fn() } as any,
      wsBridge: { markWorktree: vi.fn() } as any,
    };

    // Mock: repo exists, but no archived ref
    const getRepoInfoSpy = vi.spyOn(gitUtils, "getRepoInfoAsync").mockResolvedValue({
      repoRoot: "/tmp/test-repo",
      repoName: "test-repo",
      currentBranch: "jiayi",
      defaultBranch: "main",
      isWorktree: false,
    });
    const restoreRefSpy = vi.spyOn(gitUtils, "restoreArchivedBranchAsync").mockResolvedValue(null);
    const ensureWtSpy = vi.spyOn(gitUtils, "ensureWorktreeAsync").mockResolvedValue({
      worktreePath: "/tmp/worktrees/repo/jiayi-wt-1234",
      branch: "jiayi",
      actualBranch: "jiayi-wt-1234",
      isNew: true,
    });

    try {
      const result = await recreateWorktreeIfMissing("test-session", info, mockDeps);

      expect(result.recreated).toBe(true);

      // Should have tried the archived ref and found nothing
      expect(restoreRefSpy).toHaveBeenCalledWith("/tmp/test-repo", "jiayi-wt-9999");

      // Should have fallen back to ensureWorktreeAsync
      expect(ensureWtSpy).toHaveBeenCalledWith("/tmp/test-repo", "jiayi", {
        baseBranch: "main",
        createBranch: false,
        forceNew: true,
      });

      // Launcher should be updated with the new (fallback) branch
      expect(mockDeps.launcher.updateWorktree).toHaveBeenCalledWith("test-session", {
        cwd: "/tmp/worktrees/repo/jiayi-wt-1234",
        actualBranch: "jiayi-wt-1234",
      });
    } finally {
      getRepoInfoSpy.mockRestore();
      restoreRefSpy.mockRestore();
      ensureWtSpy.mockRestore();
    }
  });
});

// ─── migrateClaudeProjectDir ───────────────────────────────────────────────

describe("migrateClaudeProjectDir", () => {
  let tempClaudeHome: string;
  let projectsBase: string;

  beforeEach(() => {
    // Create a fake ~/.claude/projects structure in a temp dir and pass it
    // explicitly to migrateClaudeProjectDir for deterministic behavior.
    tempClaudeHome = makeTempDir();
    projectsBase = join(tempClaudeHome, ".claude", "projects");
  });

  afterEach(() => {
    rmSync(tempClaudeHome, { recursive: true });
  });

  it("moves JSONL files from old project dir to new project dir", () => {
    // Simulate: worktree was at jiayi-wt-1234, JSONL lives in that project dir.
    // Worktree is recreated at jiayi-wt-5678 — JSONL must follow.
    const oldCwd = "/mnt/home/user/.companion/worktrees/repo/branch-wt-1234";
    const newCwd = "/mnt/home/user/.companion/worktrees/repo/branch-wt-5678";

    const oldProjectDir = cwdToProjectDir(oldCwd);
    const newProjectDir = cwdToProjectDir(newCwd);
    const oldDir = join(projectsBase, oldProjectDir);

    // Create JSONL file and subagent dir at the old project dir
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(join(oldDir, "abc-123.jsonl"), '{"type":"system"}', "utf-8");
    mkdirSync(join(oldDir, "abc-123", "subagents"), { recursive: true });
    writeFileSync(join(oldDir, "abc-123", "subagents", "agent.jsonl"), '{"type":"agent"}', "utf-8");

    migrateClaudeProjectDir(oldCwd, newCwd, projectsBase);

    // JSONL should now be in the new project dir
    const newDir = join(projectsBase, newProjectDir);
    expect(existsSync(join(newDir, "abc-123.jsonl"))).toBe(true);
    expect(readFileSync(join(newDir, "abc-123.jsonl"), "utf-8")).toBe('{"type":"system"}');
    expect(existsSync(join(newDir, "abc-123", "subagents", "agent.jsonl"))).toBe(true);

    // Old dir should be removed
    expect(existsSync(oldDir)).toBe(false);
  });

  it("is a no-op when old and new cwds produce the same project dir", () => {
    const cwd = "/mnt/home/user/project";
    migrateClaudeProjectDir(cwd, cwd, projectsBase);
    // No crash, no dirs created
    expect(existsSync(join(tempClaudeHome, ".claude", "projects"))).toBe(false);
  });

  it("is a no-op when the old project dir doesn't exist", () => {
    const oldCwd = "/mnt/home/user/old-wt-1111";
    const newCwd = "/mnt/home/user/new-wt-2222";
    migrateClaudeProjectDir(oldCwd, newCwd, projectsBase);
    // No crash, new dir not created either (nothing to move)
    expect(existsSync(join(tempClaudeHome, ".claude", "projects", cwdToProjectDir(newCwd)))).toBe(false);
  });
});
