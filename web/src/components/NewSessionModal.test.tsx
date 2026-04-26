// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

const mockQueuePendingSession = vi.fn();
const mockGetGlobalNewSessionDefaults = vi.fn();
const mockGetGroupNewSessionDefaults = vi.fn();
const mockSaveGroupNewSessionDefaults = vi.fn();
const mockGetRecentDirs = vi.fn();
const mockScopedSetItem = vi.fn();

const mockApi = {
  getHome: vi.fn(),
  getCodexDefaultModel: vi.fn(),
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
    getCodexDefaultModel: (...args: unknown[]) => mockApi.getCodexDefaultModel(...args),
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
  getRecentDirs: (...args: unknown[]) => mockGetRecentDirs(...args),
}));

vi.mock("../utils/pending-creation.js", () => ({
  queuePendingSession: (...args: unknown[]) => mockQueuePendingSession(...args),
}));

vi.mock("../utils/scoped-storage.js", () => ({
  scopedGetItem: vi.fn(() => ""),
  scopedSetItem: (...args: unknown[]) => mockScopedSetItem(...args),
}));

vi.mock("../utils/new-session-defaults.js", () => ({
  getGlobalNewSessionDefaults: (...args: unknown[]) => mockGetGlobalNewSessionDefaults(...args),
  getGroupNewSessionDefaults: (...args: unknown[]) => mockGetGroupNewSessionDefaults(...args),
  saveGroupNewSessionDefaults: (...args: unknown[]) => mockSaveGroupNewSessionDefaults(...args),
  saveLastSessionCreationContext: vi.fn(),
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
    mockGetGlobalNewSessionDefaults.mockReturnValue({
      backend: "claude",
      model: "",
      mode: "agent",
      askPermission: true,
      sessionRole: "worker",
      envSlug: "",
      cwd: "",
      useWorktree: true,
      codexInternetAccess: true,
      codexReasoningEffort: "high",
    });
    mockGetGroupNewSessionDefaults.mockReturnValue({
      backend: "claude",
      model: "",
      mode: "agent",
      askPermission: true,
      sessionRole: "worker",
      envSlug: "",
      cwd: "",
      useWorktree: true,
      codexInternetAccess: true,
      codexReasoningEffort: "high",
    });
    mockApi.getHome.mockResolvedValue({ home: "/Users/test", cwd: "/tmp/project" });
    mockApi.getCodexDefaultModel.mockResolvedValue({ model: "gpt-5.5" });
    mockApi.listEnvs.mockResolvedValue([]);
    mockApi.getBackends.mockResolvedValue([
      { id: "claude", name: "Claude Code", available: true },
      { id: "codex", name: "Codex", available: true },
    ]);
    mockApi.getBackendModels.mockResolvedValue([]);
    mockApi.getRepoInfo.mockRejectedValue(new Error("not a repo"));
    mockApi.listBranches.mockResolvedValue([]);
    mockApi.gitPull.mockResolvedValue({ success: true });
    mockGetRecentDirs.mockReturnValue(["/tmp/project"]);
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

  it("loads and saves defaults using the explicit group defaults key", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    mockGetGroupNewSessionDefaults.mockReturnValue({
      backend: "claude",
      model: "",
      mode: "agent",
      askPermission: true,
      sessionRole: "worker",
      envSlug: "",
      cwd: "/tmp/tree-saved-folder",
      useWorktree: true,
      codexInternetAccess: true,
      codexReasoningEffort: "high",
    });

    render(
      <NewSessionModal
        open={true}
        onClose={onClose}
        treeGroupId="team-alpha"
        newSessionDefaultsKey="tree-group:team-alpha"
      />,
    );

    expect(mockGetGroupNewSessionDefaults).toHaveBeenCalledWith("tree-group:team-alpha");
    expect(await screen.findByText("tree-saved-folder")).toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "Create Session" }));

    await waitFor(() => {
      expect(mockSaveGroupNewSessionDefaults).toHaveBeenCalledWith(
        "tree-group:team-alpha",
        expect.objectContaining({
          backend: "claude",
          mode: "agent",
          askPermission: true,
          cwd: "/tmp/tree-saved-folder",
        }),
      );
    });
    expect(onClose).toHaveBeenCalled();
    expect(mockQueuePendingSession).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "claude",
        createOpts: expect.objectContaining({ treeGroupId: "team-alpha" }),
        cwd: "/tmp/tree-saved-folder",
        treeGroupId: "team-alpha",
        recentDirsKey: "tree-group:team-alpha",
      }),
    );
  });

  it("loads tree-group recent dirs through the explicit group key", async () => {
    mockGetGroupNewSessionDefaults.mockReturnValue({
      backend: "claude",
      model: "",
      mode: "agent",
      askPermission: true,
      sessionRole: "worker",
      envSlug: "",
      cwd: "",
      useWorktree: true,
      codexInternetAccess: true,
      codexReasoningEffort: "high",
    });
    mockGetRecentDirs.mockImplementation((key?: string) =>
      key === "tree-group:team-alpha" ? ["/tmp/team-alpha-repo"] : ["/tmp/global-repo"],
    );

    // The tree group open path should use the group's recent list, not the
    // global recent list, so locations remain isolated after reload/restart.
    render(
      <NewSessionModal
        open={true}
        onClose={() => {}}
        treeGroupId="team-alpha"
        newSessionDefaultsKey="tree-group:team-alpha"
      />,
    );

    expect(await screen.findByText("team-alpha-repo")).toBeInTheDocument();
    expect(screen.queryByText("global-repo")).not.toBeInTheDocument();
    expect(mockGetRecentDirs).toHaveBeenCalledWith("tree-group:team-alpha");
  });

  it("does not write group-scoped selections into global defaults before create", async () => {
    const user = userEvent.setup();

    // Group settings are saved under the group key on create; intermediate UI
    // changes should not overwrite the global New Session defaults.
    render(
      <NewSessionModal
        open={true}
        onClose={() => {}}
        treeGroupId="team-alpha"
        newSessionDefaultsKey="tree-group:team-alpha"
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Codex" }));

    expect(mockScopedSetItem).not.toHaveBeenCalledWith("cc-backend", "codex");
  });

  it("shows the Codex config default in the model picker when using Default", async () => {
    const user = userEvent.setup();
    mockGetGlobalNewSessionDefaults.mockReturnValue({
      backend: "codex",
      model: "",
      mode: "agent",
      askPermission: true,
      sessionRole: "worker",
      envSlug: "",
      cwd: "",
      useWorktree: true,
      codexInternetAccess: true,
      codexReasoningEffort: "high",
    });

    render(<NewSessionModal open={true} onClose={() => {}} />);

    await user.click(await screen.findByRole("button", { name: "Codex" }));

    expect(await screen.findByText("Default (gpt-5.5)")).toBeInTheDocument();
  });

  it("passes the Codex config default as the explicit model when creating from Default", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    mockGetGlobalNewSessionDefaults.mockReturnValue({
      backend: "codex",
      model: "",
      mode: "agent",
      askPermission: true,
      sessionRole: "worker",
      envSlug: "",
      cwd: "",
      useWorktree: true,
      codexInternetAccess: true,
      codexReasoningEffort: "high",
    });

    render(<NewSessionModal open={true} onClose={onClose} />);

    await user.click(await screen.findByRole("button", { name: "Create Session" }));

    await waitFor(() => {
      expect(mockQueuePendingSession).toHaveBeenCalledWith(
        expect.objectContaining({
          backend: "codex",
          createOpts: expect.objectContaining({ model: "gpt-5.5" }),
        }),
      );
    });
  });
});
