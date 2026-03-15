// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockApi = {
  getFileDiff: vi.fn().mockResolvedValue({ path: "/repo/file.ts", diff: "", baseBranch: "main" }),
  listBranches: vi.fn().mockResolvedValue([]),
  getRepoInfo: vi.fn().mockResolvedValue({
    repoRoot: "/repo",
    repoName: "repo",
    currentBranch: "main",
    defaultBranch: "main",
    isWorktree: false,
  }),
  setDiffBase: vi.fn().mockResolvedValue({ ok: true }),
  getRecentCommits: vi.fn().mockResolvedValue({ commits: [] }),
  getDiffFiles: vi.fn().mockResolvedValue({ files: [], repoRoot: "/repo", base: "main" }),
};

vi.mock("../api.js", () => ({
  api: {
    getFileDiff: (...args: unknown[]) => mockApi.getFileDiff(...args),
    listBranches: (...args: unknown[]) => mockApi.listBranches(...args),
    getRepoInfo: (...args: unknown[]) => mockApi.getRepoInfo(...args),
    setDiffBase: (...args: unknown[]) => mockApi.setDiffBase(...args),
    getRecentCommits: (...args: unknown[]) => mockApi.getRecentCommits(...args),
    getDiffFiles: (...args: unknown[]) => mockApi.getDiffFiles(...args),
  },
}));

// ─── Store mock ─────────────────────────────────────────────────────────────

interface MockStoreState {
  sessions: Map<
    string,
    {
      cwd?: string;
      repo_root?: string;
      git_default_branch?: string;
      diff_base_branch?: string;
      total_lines_added?: number;
      total_lines_removed?: number;
    }
  >;
  sdkSessions: { sessionId: string; cwd?: string; totalLinesAdded?: number; totalLinesRemoved?: number }[];
  diffPanelSelectedFile: Map<string, string>;
  changedFiles: Map<string, Set<string>>;
  setDiffPanelSelectedFile: ReturnType<typeof vi.fn>;
  setDiffFileStats: ReturnType<typeof vi.fn>;
}

let storeState: MockStoreState;

function resetStore(overrides: Partial<MockStoreState> = {}) {
  storeState = {
    sessions: new Map([["s1", { cwd: "/repo" }]]),
    sdkSessions: [],
    diffPanelSelectedFile: new Map(),
    changedFiles: new Map(),
    setDiffPanelSelectedFile: vi.fn(),
    setDiffFileStats: vi.fn(),
    ...overrides,
  };
}

vi.mock("../store.js", () => {
  const useStoreFn = (selector: (s: MockStoreState) => unknown) => selector(storeState);
  useStoreFn.getState = () => storeState;
  return { useStore: useStoreFn };
});

import { DiffPanel } from "./DiffPanel.js";

// ─── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Reset to default empty diff (clearAllMocks doesn't reset implementations)
  mockApi.getFileDiff.mockResolvedValue({ path: "/repo/file.ts", diff: "", baseBranch: "main" });
  mockApi.listBranches.mockResolvedValue([]);
  mockApi.getRepoInfo.mockResolvedValue({
    repoRoot: "/repo",
    repoName: "repo",
    currentBranch: "main",
    defaultBranch: "main",
    isWorktree: false,
  });
  mockApi.getRecentCommits.mockResolvedValue({ commits: [] });
  localStorage.clear();
  resetStore();
});

describe("DiffPanel", () => {
  it("shows empty state when no files changed", () => {
    render(<DiffPanel sessionId="s1" />);
    expect(screen.getByText("No changes yet")).toBeInTheDocument();
  });

  it("uses a dedicated mobile break row in the header for stats and controls", () => {
    render(<DiffPanel sessionId="s1" />);
    const mobileBreak = screen.getByTestId("diff-header-mobile-break");
    expect(mobileBreak).toBeInTheDocument();
    expect(mobileBreak.className).toContain("basis-full");
  });

  it("displays changed files in file picker dropdown", () => {
    // Changed files should appear in the file picker dropdown and as DiffViewer sections in the feed.
    resetStore({
      changedFiles: new Map([["s1", new Set(["/repo/src/app.ts", "/repo/src/utils.ts"])]]),
    });

    const { container } = render(<DiffPanel sessionId="s1" />);
    // File picker button shows count
    const filePickerBtn = screen.getByTitle("Jump to file");
    expect(filePickerBtn).toBeInTheDocument();
    expect(filePickerBtn.textContent).toContain("2");
    // Each file renders a DiffViewer section in the feed
    expect(container.querySelectorAll("[data-file-path]")).toHaveLength(2);
  });

  it("hides changed files outside the session cwd", () => {
    // Files outside the session cwd (e.g. plan files) should not appear in the diff panel.
    resetStore({
      changedFiles: new Map([["s1", new Set(["/repo/src/app.ts", "/Users/stan/.claude/plans/plan.md"])]]),
    });

    const { container } = render(<DiffPanel sessionId="s1" />);
    // Only 1 file (inside cwd) should be in the feed
    expect(container.querySelectorAll("[data-file-path]")).toHaveLength(1);
    expect(container.querySelector("[data-file-path='/repo/src/app.ts']")).toBeTruthy();
    expect(container.querySelector("[data-file-path='/Users/stan/.claude/plans/plan.md']")).toBeNull();
  });

  it("fetches diff when a file is selected", async () => {
    // Validates that file diffs are fetched and rendered, with the base branch selector in the header.
    const diffOutput = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,3 @@
 line1
-old line
+new line
 line3`;

    mockApi.getFileDiff.mockResolvedValue({ path: "/repo/src/app.ts", diff: diffOutput, baseBranch: "main" });

    resetStore({
      sessions: new Map([["s1", { cwd: "/repo", git_default_branch: "main" }]]),
      changedFiles: new Map([["s1", new Set(["/repo/src/app.ts"])]]),
      diffPanelSelectedFile: new Map([["s1", "/repo/src/app.ts"]]),
    });

    const { container } = render(<DiffPanel sessionId="s1" />);

    await waitFor(() => {
      // getFileDiff is called with the resolved base branch (from git_default_branch)
      expect(mockApi.getFileDiff).toHaveBeenCalledWith("/repo/src/app.ts", "main", { includeContents: true });
    });

    // DiffViewer should render the diff content (may appear in top bar + DiffViewer header)
    await waitFor(() => {
      expect(container.querySelector(".diff-line-add")).toBeTruthy();
    });
    // Base branch selector should show the resolved default
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select).toBeTruthy();
  });

  it("clears loading state when an in-flight diff request is superseded", async () => {
    // Simulate a request that never resolves, then force effectiveBranch to become null.
    // The panel should clear loading instead of being stuck forever.
    mockApi.getFileDiff.mockImplementation(() => new Promise(() => {}));
    mockApi.getRepoInfo.mockRejectedValue(new Error("no repo info"));

    resetStore({
      sessions: new Map([["s1", { cwd: "/repo", git_default_branch: "main" }]]),
      changedFiles: new Map([["s1", new Set(["/repo/src/app.ts"])]]),
      diffPanelSelectedFile: new Map([["s1", "/repo/src/app.ts"]]),
    });

    const { rerender } = render(<DiffPanel sessionId="s1" />);

    await waitFor(() => {
      expect(mockApi.getFileDiff).toHaveBeenCalledTimes(1);
    });

    // Remove branch defaults so effectiveBranch is null on re-render.
    storeState.sessions = new Map([["s1", { cwd: "/repo" }]]);
    rerender(<DiffPanel sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getByText("No changes")).toBeInTheDocument();
    });
  });

  it("hides files with zero changes once stats are loaded", async () => {
    // Files that were touched by tool calls but have no actual diff against the base branch
    // should be filtered out once their stats are fetched (empty diff → +0/-0).
    mockApi.getFileDiff.mockResolvedValue({ path: "/repo/file.ts", diff: "", baseBranch: "main" });

    resetStore({
      sessions: new Map([["s1", { cwd: "/repo", git_default_branch: "main" }]]),
      changedFiles: new Map([["s1", new Set(["/repo/file.ts"])]]),
      diffPanelSelectedFile: new Map([["s1", "/repo/file.ts"]]),
    });

    const { container } = render(<DiffPanel sessionId="s1" />);

    // After stats load (empty diff → +0/-0), the file is removed from the visible list.
    await waitFor(() => {
      expect(container.querySelectorAll("[data-file-path]")).toHaveLength(0);
    });
  });

  it("shows waiting message when session has no cwd", () => {
    resetStore({
      sessions: new Map([["s1", {}]]),
    });

    render(<DiffPanel sessionId="s1" />);
    expect(screen.getByText("Waiting for session to initialize...")).toBeInTheDocument();
  });

  it("treats server 0 diff stats as authoritative over stale sdk stats", () => {
    // Regression: use nullish coalescing for line stats so 0 from bridge state
    // does not fall back to stale non-zero sdk values.
    resetStore({
      sessions: new Map([["s1", { cwd: "/repo", total_lines_added: 0, total_lines_removed: 0 }]]),
      sdkSessions: [{ sessionId: "s1", cwd: "/repo", totalLinesAdded: 34, totalLinesRemoved: 2 }],
    });

    const { container } = render(<DiffPanel sessionId="s1" />);
    // Header stat row should stay hidden because authoritative totals are 0/0.
    expect(container.querySelector(".text-green-500")).toBeNull();
    expect(container.querySelector(".text-red-400")).toBeNull();
  });

  it("falls back to rendered diff totals when server totals are zero", async () => {
    // If server totals are temporarily stale at 0/0 but the panel has fetched
    // diffs, the header should use local per-file totals for consistency.
    mockApi.getFileDiff.mockResolvedValue({
      path: "/repo/src/app.ts",
      diff: `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1,2 @@
 old
+new`,
      baseBranch: "main",
    });

    resetStore({
      sessions: new Map([
        ["s1", { cwd: "/repo", git_default_branch: "main", total_lines_added: 0, total_lines_removed: 0 }],
      ]),
      changedFiles: new Map([["s1", new Set(["/repo/src/app.ts"])]]),
      diffPanelSelectedFile: new Map([["s1", "/repo/src/app.ts"]]),
    });

    render(<DiffPanel sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getByText("+1")).toBeInTheDocument();
      expect(screen.getByText("-0")).toBeInTheDocument();
    });
  });

  it("reselects when selected file is outside cwd scope", async () => {
    resetStore({
      changedFiles: new Map([["s1", new Set(["/repo/src/inside.ts"])]]),
      diffPanelSelectedFile: new Map([["s1", "/Users/stan/.claude/plans/plan.md"]]),
    });

    render(<DiffPanel sessionId="s1" />);
    await waitFor(() => {
      expect(storeState.setDiffPanelSelectedFile).toHaveBeenCalledWith("s1", "/repo/src/inside.ts");
    });
  });

  it("passes user-selected base branch to API calls", async () => {
    // When diff_base_branch is set in server session state, it should be passed to getFileDiff.
    const diffOutput = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1,2 @@
 line1
+added`;
    mockApi.getFileDiff.mockResolvedValue({ path: "/repo/src/app.ts", diff: diffOutput, baseBranch: "develop" });

    resetStore({
      sessions: new Map([["s1", { cwd: "/repo", diff_base_branch: "develop" }]]),
      changedFiles: new Map([["s1", new Set(["/repo/src/app.ts"])]]),
      diffPanelSelectedFile: new Map([["s1", "/repo/src/app.ts"]]),
    });

    render(<DiffPanel sessionId="s1" />);

    await waitFor(() => {
      expect(mockApi.getFileDiff).toHaveBeenCalledWith("/repo/src/app.ts", "develop", { includeContents: true });
    });
  });

  it("preserves remote tracking refs from server state in the branch selector", async () => {
    // Regression: non-worktree defaults may now be remote refs (e.g. origin/jiayi).
    // Ensure the select includes that value even when local branch list omits it.
    mockApi.listBranches.mockResolvedValue([{ name: "jiayi", isCurrent: true, isRemote: false }]);
    mockApi.getFileDiff.mockResolvedValue({
      path: "/repo/src/app.ts",
      diff: "diff --git a/src/app.ts b/src/app.ts\n",
      baseBranch: "origin/jiayi",
    });

    resetStore({
      sessions: new Map([
        ["s1", { cwd: "/repo", diff_base_branch: "origin/jiayi", git_default_branch: "origin/jiayi" }],
      ]),
      changedFiles: new Map([["s1", new Set(["/repo/src/app.ts"])]]),
      diffPanelSelectedFile: new Map([["s1", "/repo/src/app.ts"]]),
    });

    render(<DiffPanel sessionId="s1" />);

    await waitFor(() => {
      expect(mockApi.getFileDiff).toHaveBeenCalledWith("/repo/src/app.ts", "origin/jiayi", { includeContents: true });
    });

    const [branchSelect] = screen.getAllByRole("combobox") as HTMLSelectElement[];
    expect(branchSelect.value).toBe("origin/jiayi");
    const optionValues = [...branchSelect.options].map((o) => o.value);
    expect(optionValues).toContain("origin/jiayi");
  });

  it("displays changed files in worktree sessions where repo_root differs from cwd", () => {
    // In a worktree, repo_root points to the main repo (e.g. /main/companion) but
    // the session cwd is the worktree directory. Files under the worktree should appear.
    resetStore({
      sessions: new Map([["s1", { cwd: "/home/user/.worktrees/wt-1", repo_root: "/home/user/companion" }]]),
      changedFiles: new Map([
        ["s1", new Set(["/home/user/.worktrees/wt-1/web/src/app.ts", "/home/user/.worktrees/wt-1/web/src/utils.ts"])],
      ]),
    });

    const { container } = render(<DiffPanel sessionId="s1" />);
    // Both worktree files should be in the diff feed
    expect(container.querySelectorAll("[data-file-path]")).toHaveLength(2);
    expect(container.querySelector("[data-file-path='/home/user/.worktrees/wt-1/web/src/app.ts']")).toBeTruthy();
    expect(container.querySelector("[data-file-path='/home/user/.worktrees/wt-1/web/src/utils.ts']")).toBeTruthy();
  });

  it("uses repo_root as scope when cwd is a subdirectory of repo_root", () => {
    // When cwd is a subdirectory of repo_root, files at the repo root level
    // (e.g. CLAUDE.md) should still be visible in the diff panel.
    resetStore({
      sessions: new Map([["s1", { cwd: "/repo/packages/app", repo_root: "/repo" }]]),
      changedFiles: new Map([["s1", new Set(["/repo/CLAUDE.md", "/repo/packages/app/src/index.ts"])]]),
    });

    const { container } = render(<DiffPanel sessionId="s1" />);
    // Both files (root-level and nested) should be in the diff feed
    expect(container.querySelectorAll("[data-file-path]")).toHaveLength(2);
    expect(container.querySelector("[data-file-path='/repo/CLAUDE.md']")).toBeTruthy();
    expect(container.querySelector("[data-file-path='/repo/packages/app/src/index.ts']")).toBeTruthy();
  });

  it("restores previous branch selection when commit selector is cleared", async () => {
    mockApi.listBranches.mockResolvedValue([{ name: "develop" }, { name: "main" }]);
    mockApi.getRecentCommits.mockResolvedValue({
      commits: [{ sha: "abcdef1234567890", shortSha: "abcdef1", message: "Recent commit", timestamp: Date.now() }],
    });
    mockApi.getFileDiff.mockResolvedValue({
      path: "/repo/src/app.ts",
      diff: "diff --git a/src/app.ts b/src/app.ts\n",
      baseBranch: "develop",
    });

    resetStore({
      sessions: new Map([["s1", { cwd: "/repo", diff_base_branch: "develop", git_default_branch: "main" }]]),
      changedFiles: new Map([["s1", new Set(["/repo/src/app.ts"])]]),
      diffPanelSelectedFile: new Map([["s1", "/repo/src/app.ts"]]),
    });

    render(<DiffPanel sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getAllByRole("combobox").length).toBeGreaterThanOrEqual(2);
    });

    const [branchSelect, commitSelect] = screen.getAllByRole("combobox") as HTMLSelectElement[];
    expect(branchSelect.value).toBe("develop");

    fireEvent.change(commitSelect, { target: { value: "abcdef1234567890" } });
    await waitFor(() => {
      expect(mockApi.setDiffBase).toHaveBeenCalledWith("s1", "abcdef1234567890");
    });

    fireEvent.change(commitSelect, { target: { value: "" } });
    await waitFor(() => {
      expect(mockApi.setDiffBase).toHaveBeenLastCalledWith("s1", "develop");
    });
    expect(branchSelect.value).toBe("develop");
  });

  it("clearing commit falls back to default branch when no explicit branch is selected", async () => {
    mockApi.listBranches.mockResolvedValue([{ name: "main" }]);
    mockApi.getRecentCommits.mockResolvedValue({
      commits: [{ sha: "abcdef1234567890", shortSha: "abcdef1", message: "Recent commit", timestamp: Date.now() }],
    });
    mockApi.getFileDiff.mockResolvedValue({
      path: "/repo/src/app.ts",
      diff: "diff --git a/src/app.ts b/src/app.ts\n",
      baseBranch: "abcdef1234567890",
    });

    resetStore({
      sessions: new Map([["s1", { cwd: "/repo", diff_base_branch: "abcdef1234567890", git_default_branch: "main" }]]),
      changedFiles: new Map([["s1", new Set(["/repo/src/app.ts"])]]),
      diffPanelSelectedFile: new Map([["s1", "/repo/src/app.ts"]]),
    });

    render(<DiffPanel sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getAllByRole("combobox").length).toBeGreaterThanOrEqual(2);
    });

    const [branchSelect, commitSelect] = screen.getAllByRole("combobox") as HTMLSelectElement[];
    expect(branchSelect.value).toBe("");
    expect(commitSelect.value).toBe("abcdef1234567890");

    fireEvent.change(commitSelect, { target: { value: "" } });

    await waitFor(() => {
      expect(mockApi.setDiffBase).toHaveBeenLastCalledWith("s1", "main");
    });
    expect(branchSelect.value).toBe("main");
  });
});
