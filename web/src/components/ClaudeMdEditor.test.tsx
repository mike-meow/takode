// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
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
});
