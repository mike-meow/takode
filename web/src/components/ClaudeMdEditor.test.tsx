// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { ClaudeMdEditor } from "./ClaudeMdEditor.js";

const mockApi = {
  getClaudeMdFiles: vi.fn(),
  getAutoApprovalConfigForPath: vi.fn(),
  saveClaudeMd: vi.fn(),
};

vi.mock("../api.js", () => ({
  api: {
    getClaudeMdFiles: (...args: unknown[]) => mockApi.getClaudeMdFiles(...args),
    getAutoApprovalConfigForPath: (...args: unknown[]) => mockApi.getAutoApprovalConfigForPath(...args),
    saveClaudeMd: (...args: unknown[]) => mockApi.saveClaudeMd(...args),
  },
}));

describe("ClaudeMdEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getAutoApprovalConfigForPath.mockResolvedValue({ config: null });
  });

  it("preselects the requested file path when opening", async () => {
    mockApi.getClaudeMdFiles.mockResolvedValue({
      cwd: "/repo",
      files: [
        { path: "/repo/CLAUDE.md", content: "root file", writable: true },
        { path: "/repo/.claude/CLAUDE.md", content: "nested file", writable: true },
      ],
    });

    render(
      <ClaudeMdEditor
        cwd="/repo"
        open
        initialPath="/repo/.claude/CLAUDE.md"
        onClose={() => {}}
      />,
    );

    await waitFor(() => {
      const textarea = screen.getByPlaceholderText("Write your project instructions here...") as HTMLTextAreaElement;
      expect(textarea.value).toBe("nested file");
    });
  });

  it("marks settings files as read-only and disables save", async () => {
    mockApi.getClaudeMdFiles.mockResolvedValue({
      cwd: "/repo",
      files: [
        { path: "/repo/.claude/settings.json", content: "{\"model\":\"sonnet\"}", writable: false },
      ],
    });

    render(
      <ClaudeMdEditor
        cwd="/repo"
        open
        initialPath="/repo/.claude/settings.json"
        onClose={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Read-only")).toBeTruthy();
    });
    const saveButton = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
  });

  it("does not close modal when switching files inside the selector", async () => {
    mockApi.getClaudeMdFiles.mockResolvedValue({
      cwd: "/repo",
      files: [
        { path: "/repo/CLAUDE.md", content: "root file", writable: true },
        { path: "/repo/.claude/CLAUDE.md", content: "nested file", writable: true },
      ],
    });
    const onClose = vi.fn();

    render(
      <ClaudeMdEditor
        cwd="/repo"
        open
        initialPath="/repo/CLAUDE.md"
        onClose={onClose}
      />,
    );

    await waitFor(() => {
      const textarea = screen.getByPlaceholderText("Write your project instructions here...") as HTMLTextAreaElement;
      expect(textarea.value).toBe("root file");
    });

    // Desktop and mobile selectors can both exist in the DOM; click any matching entry.
    const selectorButtons = screen.getAllByText(".claude/CLAUDE.md");
    fireEvent.click(selectorButtons[0]);

    await waitFor(() => {
      const textarea = screen.getByPlaceholderText("Write your project instructions here...") as HTMLTextAreaElement;
      expect(textarea.value).toBe("nested file");
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("opens directly in auto-approval view when requested", async () => {
    mockApi.getClaudeMdFiles.mockResolvedValue({
      cwd: "/repo",
      files: [{ path: "/repo/CLAUDE.md", content: "root file", writable: true }],
    });
    mockApi.getAutoApprovalConfigForPath.mockResolvedValue({
      config: {
        slug: "repo",
        projectPath: "/repo",
        label: "Repo defaults",
        criteria: "Allow harmless commands",
        enabled: true,
      },
    });

    render(
      <ClaudeMdEditor
        cwd="/repo"
        open
        initialView="autoApproval"
        onClose={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Read-only")).toBeTruthy();
      expect(screen.getByText("Allow harmless commands")).toBeTruthy();
    });
  });
});
