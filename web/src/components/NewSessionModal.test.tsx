// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

const mockApi = {
  getHome: vi.fn(),
  listEnvs: vi.fn(),
  getBackends: vi.fn(),
  getBackendModels: vi.fn(),
  getRepoInfo: vi.fn(),
  listBranches: vi.fn(),
  gitPull: vi.fn(),
  listCliSessions: vi.fn(),
};

vi.mock("../api.js", () => ({
  api: {
    getHome: (...args: unknown[]) => mockApi.getHome(...args),
    listEnvs: (...args: unknown[]) => mockApi.listEnvs(...args),
    getBackends: (...args: unknown[]) => mockApi.getBackends(...args),
    getBackendModels: (...args: unknown[]) => mockApi.getBackendModels(...args),
    getRepoInfo: (...args: unknown[]) => mockApi.getRepoInfo(...args),
    listBranches: (...args: unknown[]) => mockApi.listBranches(...args),
    gitPull: (...args: unknown[]) => mockApi.gitPull(...args),
    listCliSessions: (...args: unknown[]) => mockApi.listCliSessions(...args),
  },
}));

vi.mock("../utils/recent-dirs.js", () => ({
  getRecentDirs: () => ["/tmp/project"],
}));

vi.mock("../utils/pending-creation.js", () => ({
  queuePendingSession: vi.fn(),
}));

vi.mock("../utils/scoped-storage.js", () => ({
  scopedGetItem: vi.fn(() => ""),
  scopedSetItem: vi.fn(),
}));

vi.mock("../utils/new-session-defaults.js", () => ({
  getGlobalNewSessionDefaults: () => ({
    backend: "claude",
    model: "",
    mode: "agent",
    askPermission: true,
    envSlug: "",
    useWorktree: true,
    codexInternetAccess: true,
    codexReasoningEffort: "high",
  }),
  getGroupNewSessionDefaults: () => ({
    backend: "claude",
    model: "",
    mode: "agent",
    askPermission: true,
    envSlug: "",
    useWorktree: true,
    codexInternetAccess: true,
    codexReasoningEffort: "high",
  }),
  saveGroupNewSessionDefaults: vi.fn(),
}));

vi.mock("./EnvManager.js", () => ({
  EnvManager: () => null,
}));

vi.mock("./FolderPicker.js", () => ({
  FolderPicker: () => null,
}));

vi.mock("./CatIcons.js", () => ({
  YarnBallSpinner: (props: { className?: string }) => <div data-testid="spinner" className={props.className} />,
}));

import { NewSessionModal } from "./NewSessionModal.js";

describe("NewSessionModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getHome.mockResolvedValue({ home: "/Users/test", cwd: "/tmp/project" });
    mockApi.listEnvs.mockResolvedValue([]);
    mockApi.getBackends.mockResolvedValue([
      { id: "claude", name: "Claude Code", available: true },
      { id: "codex", name: "Codex", available: true },
    ]);
    mockApi.getBackendModels.mockResolvedValue([]);
    mockApi.getRepoInfo.mockRejectedValue(new Error("not a repo"));
    mockApi.listBranches.mockResolvedValue([]);
    mockApi.gitPull.mockResolvedValue({ success: true });
    mockApi.listCliSessions.mockImplementation((backend?: "claude" | "codex") =>
      Promise.resolve({
        sessions:
          backend === "codex"
            ? [
                {
                  id: "codex-session-1",
                  cwd: "/tmp/codex-project",
                  slug: "codex-session",
                  gitBranch: "main",
                  lastModified: 1_775_022_000_000,
                  sizeBytes: 123,
                  backend: "codex",
                },
              ]
            : [],
      }),
    );
  });

  it("lets resume mode switch from Claude to Codex sessions", async () => {
    const user = userEvent.setup();
    render(<NewSessionModal open={true} onClose={() => {}} />);

    await user.click(await screen.findByText("Resume from an existing CLI session"));

    // Regression coverage: the modal opens in the global default backend
    // (Claude here), but resume mode must still let the user switch to Codex.
    await waitFor(() => expect(mockApi.listCliSessions).toHaveBeenCalledWith("claude"));
    expect(screen.getByText("No Claude Code CLI sessions found")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Codex" }));

    await waitFor(() => expect(mockApi.listCliSessions).toHaveBeenCalledWith("codex"));
    expect(await screen.findByText("codex-session")).toBeInTheDocument();
    expect(screen.queryByText("No Claude Code CLI sessions found")).not.toBeInTheDocument();
  });
});
