// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

const mockQueuePendingSession = vi.fn();
const mockGetGlobalNewSessionDefaults = vi.fn();
const mockGetGroupNewSessionDefaults = vi.fn();
const mockGetCachedGroupNewSessionDefaults = vi.fn();
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
  getNewSessionDefaults: vi.fn(),
  saveNewSessionDefaults: vi.fn(),
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
    getNewSessionDefaults: (...args: unknown[]) => mockApi.getNewSessionDefaults(...args),
    saveNewSessionDefaults: (...args: unknown[]) => mockApi.saveNewSessionDefaults(...args),
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
  getCachedGroupNewSessionDefaults: (...args: unknown[]) => mockGetCachedGroupNewSessionDefaults(...args),
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
    mockGetCachedGroupNewSessionDefaults.mockReturnValue(null);
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
    mockApi.getNewSessionDefaults.mockResolvedValue({ key: "tree-group:team-alpha", defaults: null, updatedAt: null });
    mockApi.saveNewSessionDefaults.mockResolvedValue({
      ok: true,
      key: "tree-group:team-alpha",
      defaults: null,
      updatedAt: Date.now(),
    });
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

  it("hydrates tree-group defaults from the server-backed store", async () => {
    const serverDefaults = {
      backend: "codex" as const,
      model: "gpt-5.5",
      mode: "agent",
      askPermission: false,
      sessionRole: "worker" as const,
      envSlug: "sandbox",
      cwd: "/tmp/server-folder",
      useWorktree: false,
      codexInternetAccess: false,
      codexReasoningEffort: "medium",
    };
    mockGetGroupNewSessionDefaults.mockReturnValue({
      backend: "claude",
      model: "",
      mode: "agent",
      askPermission: true,
      sessionRole: "worker",
      envSlug: "",
      cwd: "/tmp/local-folder",
      useWorktree: true,
      codexInternetAccess: true,
      codexReasoningEffort: "high",
    });
    mockApi.getNewSessionDefaults.mockResolvedValue({
      key: "tree-group:team-alpha",
      defaults: serverDefaults,
      updatedAt: 123,
    });

    render(
      <NewSessionModal
        open={true}
        onClose={() => {}}
        treeGroupId="team-alpha"
        newSessionDefaultsKey="tree-group:team-alpha"
      />,
    );

    expect(await screen.findByText("server-folder")).toBeInTheDocument();
    expect(mockSaveGroupNewSessionDefaults).toHaveBeenCalledWith("tree-group:team-alpha", serverDefaults);
  });

  it("migrates cached tree-group defaults to the server when no server value exists", async () => {
    const cachedDefaults = {
      backend: "claude" as const,
      model: "",
      mode: "agent",
      askPermission: true,
      sessionRole: "worker" as const,
      envSlug: "",
      cwd: "/tmp/cached-folder",
      useWorktree: true,
      codexInternetAccess: false,
      codexReasoningEffort: "",
    };
    mockGetCachedGroupNewSessionDefaults.mockReturnValue(cachedDefaults);
    mockApi.getNewSessionDefaults.mockResolvedValue({
      key: "tree-group:team-alpha",
      defaults: null,
      updatedAt: null,
    });

    render(
      <NewSessionModal
        open={true}
        onClose={() => {}}
        treeGroupId="team-alpha"
        newSessionDefaultsKey="tree-group:team-alpha"
      />,
    );

    await waitFor(() => {
      expect(mockApi.saveNewSessionDefaults).toHaveBeenCalledWith("tree-group:team-alpha", cachedDefaults);
    });
  });

  it("does not let the server home fallback overwrite hydrated cwd", async () => {
    let resolveHome: (value: { home: string; cwd: string }) => void = () => {};
    mockApi.getHome.mockReturnValue(
      new Promise((resolve) => {
        resolveHome = resolve;
      }),
    );
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
    mockGetRecentDirs.mockReturnValue([]);
    mockApi.getNewSessionDefaults.mockResolvedValue({
      key: "tree-group:team-alpha",
      defaults: {
        backend: "claude",
        model: "",
        mode: "agent",
        askPermission: true,
        sessionRole: "worker",
        envSlug: "",
        cwd: "/tmp/server-backed",
        useWorktree: true,
        codexInternetAccess: false,
        codexReasoningEffort: "",
      },
      updatedAt: 123,
    });

    render(
      <NewSessionModal
        open={true}
        onClose={() => {}}
        treeGroupId="team-alpha"
        newSessionDefaultsKey="tree-group:team-alpha"
      />,
    );

    expect(await screen.findByText("server-backed")).toBeInTheDocument();
    resolveHome({ home: "/Users/test", cwd: "/tmp/process-cwd" });

    await waitFor(() => {
      expect(screen.getByText("server-backed")).toBeInTheDocument();
    });
    expect(screen.queryByText("process-cwd")).not.toBeInTheDocument();
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
