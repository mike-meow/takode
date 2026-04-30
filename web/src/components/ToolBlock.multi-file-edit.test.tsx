// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "../api.js";
import { useStore } from "../store.js";
import { ToolBlock } from "./ToolBlock.js";

vi.mock("../api.js", () => ({
  api: {
    getSettings: vi.fn(),
    getToolResult: vi.fn(),
    getFsImageUrl: vi.fn((path: string) => `/api/fs/image?path=${encodeURIComponent(path)}`),
    openVsCodeRemoteFile: vi.fn(),
  },
}));

beforeEach(() => {
  vi.mocked(api.getSettings).mockReset();
  vi.mocked(api.getToolResult).mockReset();
  vi.mocked(api.openVsCodeRemoteFile).mockReset();
  vi.mocked(api.getSettings).mockResolvedValue({ editorConfig: { editor: "vscode-local" } } as Awaited<
    ReturnType<typeof api.getSettings>
  >);
  useStore.setState({ toolResults: new Map(), latestBoardToolUseId: new Map() });
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

describe("ToolBlock multi-file Edit rendering", () => {
  it("renders changes under each change path when file_path points at the first file", async () => {
    // Regression for q-997: one apply_patch/Edit tool can set top-level
    // file_path to the first file while carrying headerless hunks for multiple
    // change.path values. The UI must not render later hunks under that first
    // file's header or Open File target.
    window.history.replaceState({}, "", "/?takodeHost=vscode");
    const postMessageSpy = vi.spyOn(window.parent, "postMessage");
    const leaderDispatchPath = "/Users/jiayiwei/Code/companion/.claude/skills/leader-dispatch/SKILL.md";
    const questDesignPath = "/Users/jiayiwei/Code/companion/.claude/skills/quest-design/SKILL.md";

    const { container } = render(
      <ToolBlock
        name="Edit"
        input={{
          file_path: leaderDispatchPath,
          changes: [
            {
              path: leaderDispatchPath,
              kind: "update",
              diff: [
                "@@ -56,2 +56,4 @@",
                " ",
                "+When a proposal includes multiple non-standard phase notes, format them as bullets keyed by phase.",
                "+",
                " The scheduling/orchestration plan must state at least:",
              ].join("\n"),
            },
            {
              path: questDesignPath,
              kind: "update",
              diff: [
                "@@ -42,2 +42,4 @@",
                " ",
                "+When a proposal includes multiple non-standard phase notes, format them as bullets keyed by phase.",
                "+",
                " Clarification-needed case: ask the material questions using the quest framing below.",
              ].join("\n"),
            },
          ],
        }}
        toolUseId="tool-multi-file-path-repro"
        defaultOpen={false}
      />,
    );

    const header = screen.getByRole("button", { name: /Edit File.*2 files/ });
    expect(header.textContent).not.toContain("leader-dispatch");
    expect(screen.queryByRole("button", { name: "Open File" })).toBeNull();

    fireEvent.click(header);

    const diffFiles = Array.from(container.querySelectorAll(".diff-file"));
    expect(diffFiles).toHaveLength(2);
    expect(diffFiles[0].textContent).toContain("leader-dispatch");
    expect(diffFiles[0].textContent).toContain("@@ -56,2 +56,4 @@");
    expect(diffFiles[1].textContent).toContain("quest-design");
    expect(diffFiles[1].textContent).toContain("@@ -42,2 +42,4 @@");

    const openButtons = screen.getAllByRole("button", { name: "Open File" });
    expect(openButtons).toHaveLength(2);

    fireEvent.click(openButtons[0]);
    fireEvent.click(openButtons[1]);

    await waitFor(() => {
      expect(postMessageSpy).toHaveBeenCalledWith(
        {
          source: "takode-vscode-prototype",
          type: "takode:open-file",
          payload: { absolutePath: leaderDispatchPath, line: 56, column: 1 },
        },
        "*",
      );
      expect(postMessageSpy).toHaveBeenCalledWith(
        {
          source: "takode-vscode-prototype",
          type: "takode:open-file",
          payload: { absolutePath: questDesignPath, line: 42, column: 1 },
        },
        "*",
      );
    });
  });
});
