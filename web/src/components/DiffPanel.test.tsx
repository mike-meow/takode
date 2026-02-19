// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockApi = {
  getFileDiff: vi.fn().mockResolvedValue({ path: "/repo/file.ts", diff: "", baseBranch: "main" }),
  listBranches: vi.fn().mockResolvedValue([]),
  getRepoInfo: vi.fn().mockResolvedValue({ repoRoot: "/repo", repoName: "repo", currentBranch: "main", defaultBranch: "main", isWorktree: false }),
  setDiffBase: vi.fn().mockResolvedValue({ ok: true }),
};

vi.mock("../api.js", () => ({
  api: {
    getFileDiff: (...args: unknown[]) => mockApi.getFileDiff(...args),
    listBranches: (...args: unknown[]) => mockApi.listBranches(...args),
    getRepoInfo: (...args: unknown[]) => mockApi.getRepoInfo(...args),
    setDiffBase: (...args: unknown[]) => mockApi.setDiffBase(...args),
  },
}));

// ─── Store mock ─────────────────────────────────────────────────────────────

interface MockStoreState {
  sessions: Map<string, { cwd?: string; repo_root?: string; git_default_branch?: string; diff_base_branch?: string }>;
  sdkSessions: { sessionId: string; cwd?: string }[];
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
  mockApi.getRepoInfo.mockResolvedValue({ repoRoot: "/repo", repoName: "repo", currentBranch: "main", defaultBranch: "main", isWorktree: false });
  localStorage.clear();
  resetStore();
});

describe("DiffPanel", () => {
  it("shows empty state when no files changed", () => {
    const { container } = render(<DiffPanel sessionId="s1" />);
    expect(screen.getByText("No changes yet")).toBeInTheDocument();
  });

  it("displays changed files in sidebar", () => {
    resetStore({
      changedFiles: new Map([["s1", new Set(["/repo/src/app.ts", "/repo/src/utils.ts"])]]),
    });

    const { container } = render(<DiffPanel sessionId="s1" />);
    expect(screen.getByText("Changed (2)")).toBeInTheDocument();
    expect(screen.getByText("src/app.ts")).toBeInTheDocument();
    expect(screen.getByText("src/utils.ts")).toBeInTheDocument();
  });

  it("hides changed files outside the session cwd", () => {
    resetStore({
      changedFiles: new Map([
        ["s1", new Set(["/repo/src/app.ts", "/Users/stan/.claude/plans/plan.md"])],
      ]),
    });

    const { container } = render(<DiffPanel sessionId="s1" />);
    expect(screen.getByText("Changed (1)")).toBeInTheDocument();
    expect(screen.getByText("src/app.ts")).toBeInTheDocument();
    expect(screen.queryByText("/Users/stan/.claude/plans/plan.md")).not.toBeInTheDocument();
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
      changedFiles: new Map([["s1", new Set(["/repo/src/app.ts"])]]),
      diffPanelSelectedFile: new Map([["s1", "/repo/src/app.ts"]]),
    });

    const { container } = render(<DiffPanel sessionId="s1" />);

    await waitFor(() => {
      // getFileDiff is called with optional baseBranch param (undefined when using default)
      expect(mockApi.getFileDiff).toHaveBeenCalledWith("/repo/src/app.ts", undefined);
    });

    // DiffViewer should render the diff content (may appear in top bar + DiffViewer header)
    await waitFor(() => {
      expect(container.querySelector(".diff-line-add")).toBeTruthy();
    });
    // Base branch selector should show the resolved default
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select).toBeTruthy();
  });

  it("hides files with zero changes once stats are loaded", async () => {
    // Files that were touched by tool calls but have no actual diff against the base branch
    // should be filtered out of the sidebar once their stats are fetched.
    mockApi.getFileDiff.mockResolvedValue({ path: "/repo/file.ts", diff: "", baseBranch: "main" });

    resetStore({
      changedFiles: new Map([["s1", new Set(["/repo/file.ts"])]]),
      diffPanelSelectedFile: new Map([["s1", "/repo/file.ts"]]),
    });

    render(<DiffPanel sessionId="s1" />);

    // After stats load (empty diff → +0/-0), the file is removed from visible list,
    // falling through to the empty state.
    await waitFor(() => {
      expect(screen.getByText("No changes yet")).toBeInTheDocument();
    });
  });

  it("shows waiting message when session has no cwd", () => {
    resetStore({
      sessions: new Map([["s1", {}]]),
    });

    render(<DiffPanel sessionId="s1" />);
    expect(screen.getByText("Waiting for session to initialize...")).toBeInTheDocument();
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
      expect(mockApi.getFileDiff).toHaveBeenCalledWith("/repo/src/app.ts", "develop");
    });
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

    render(<DiffPanel sessionId="s1" />);
    expect(screen.getByText("Changed (2)")).toBeInTheDocument();
    expect(screen.getByText("web/src/app.ts")).toBeInTheDocument();
    expect(screen.getByText("web/src/utils.ts")).toBeInTheDocument();
  });

  it("uses repo_root as scope when cwd is a subdirectory of repo_root", () => {
    // When cwd is a subdirectory of repo_root, files at the repo root level
    // (e.g. CLAUDE.md) should still be visible in the diff panel.
    resetStore({
      sessions: new Map([["s1", { cwd: "/repo/packages/app", repo_root: "/repo" }]]),
      changedFiles: new Map([
        ["s1", new Set(["/repo/CLAUDE.md", "/repo/packages/app/src/index.ts"])],
      ]),
    });

    render(<DiffPanel sessionId="s1" />);
    expect(screen.getByText("Changed (2)")).toBeInTheDocument();
    expect(screen.getByText("CLAUDE.md")).toBeInTheDocument();
    expect(screen.getByText("packages/app/src/index.ts")).toBeInTheDocument();
  });
});
